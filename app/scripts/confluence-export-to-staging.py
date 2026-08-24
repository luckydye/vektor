#!/usr/bin/env python3
"""
Confluence Server space export -> import staging database. Stage 1 of 2.

    python3 scripts/confluence-export-to-staging.py <export-dir> --owner <userId> [options]

Reads a Confluence space export (`entities.xml` + `attachments/`) and emits

    <out>/staging.db        documents, revisions, categories and upload rows
    <out>/uploads/<key>     attachment payloads under their content-addressable key

Nothing here touches a Vektor database; `confluence-staging-to-space.ts` turns the
staging database into a real space. The split exists because the export's
`entities.xml` runs to hundreds of MB and needs a streaming XML parser, while
revision snapshots need brotli, which the system Python does not ship.

Conversion targets the editor schema in `src/documents/schema/specs.ts`: every
construct emitted here has a matching node or mark spec, and anything
Confluence-specific without an equivalent is downgraded to a supported construct
or dropped and counted. Stage 2 still normalizes the result through
`htmlToDoc`/`docToHtml`, so this stage aims to be faithful rather than canonical.

See scripts/confluence-import.md.
"""

import argparse
import collections
import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import quote, quote_plus
from xml.etree import ElementTree as ET

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

# Populated from the command line in main(); module-level so the converter can
# read them without threading options through every call.
EXPORT_ROOT = ""
STAGING_DIR = ""
STAGING_DB = ""
STAGING_UPLOADS = ""
SPACE_NAME = ""
SPACE_SLUG = ""
DEFAULT_USER_ID = ""
USER_MAP_PATH = None

# Origin of the Confluence instance the export came from. Page references that
# cannot be resolved inside the import (other spaces, deleted pages) are
# repointed there instead of being flattened to plain text.
CONFLUENCE_BASE_URL = ""

# Stable ids across re-runs: same source object -> same Vektor id.
ID_NAMESPACE = uuid.UUID("6f9b1e64-3a2f-5c8d-9e71-2b4c6a8d0f13")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Convert a Confluence Server space export into import staging data.",
    )
    parser.add_argument("export_dir",
                        help="directory holding entities.xml and attachments/")
    parser.add_argument("--owner", required=True,
                        help="Vektor user id owning the space and any content "
                             "whose author cannot be mapped")
    parser.add_argument("--out", default="data/confluence-staging",
                        help="staging output directory (default: %(default)s)")
    parser.add_argument("--space-name",
                        help="space name (default: the Confluence space name)")
    parser.add_argument("--space-slug",
                        help="space slug (default: slugified space key)")
    parser.add_argument("--confluence-url", default="",
                        help="origin of the source Confluence instance, e.g. "
                             "https://confluence.example.com. Unresolvable page "
                             "links are repointed there; omit to keep them as "
                             "plain text.")
    parser.add_argument("--users",
                        help="JSON file mapping lowercase email -> Vektor user "
                             "id, used to preserve authorship")
    parser.add_argument("--page-limit", type=int, default=0,
                        help="convert at most N pages (smoke tests)")
    parser.add_argument("--max-revisions", type=int, default=0,
                        help="keep at most N newest revisions per page "
                             "(smoke tests)")
    return parser.parse_args(argv)

VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}

# Vektor inline nodes/marks (specs.ts: group "inline" or kind "mark").
INLINE_TAGS = {
    "a", "strong", "em", "u", "s", "code", "sup", "sub", "span", "br",
    "user-mention", "document-mention", "date-picker", "ticket-link",
    "expression-cell",
}

# Confluence status lozenge colour -> (background, foreground).
STATUS_COLOURS = {
    "grey": ("#dfe1e6", "#42526e"),
    "green": ("#e3fcef", "#006644"),
    "yellow": ("#fffae6", "#974f0c"),
    "red": ("#ffebe6", "#bf2600"),
    "blue": ("#deebff", "#0747a6"),
}

EMOTICONS = {
    "tick": "✔", "cross": "✘", "minus": "−", "plus": "+",
    "yellow-star": "⭐", "red-star": "★", "check mark button": "✅",
    "smile": "\U0001f642", "wink": "\U0001f609", "laugh": "\U0001f604",
    "sad": "\U0001f641", "thumbs-up": "\U0001f44d", "thumbs-down": "\U0001f44e",
    "question": "❓", "warning": "⚠️", "information": "ℹ️",
    "light-on": "\U0001f4a1", "light-off": "\U0001f50c", "heart": "❤️",
    "broken-heart": "\U0001f494",
}

# Emoticons Confluence serves as <img> from its own /images/icons/emoticons/
# path rather than as <ac:emoticon>.
ICON_EMOTICONS = {
    "warning": "⚠️", "add": "+", "forbidden": "🚫", "star_yellow": "⭐",
    "check": "✔", "error": "✘", "help_16": "❓", "information": "ℹ️",
    "wink": "\U0001f609", "smile": "\U0001f642", "sad": "\U0001f641",
    "thumbs_up": "\U0001f44d", "thumbs_down": "\U0001f44e",
    "lightbulb_on": "\U0001f4a1", "lightbulb": "\U0001f50c",
    "star_red": "★", "star_green": "⭐", "star_blue": "⭐",
    "heart": "❤️", "broken_heart": "\U0001f494",
}

# Macros whose rich-text-body is real content and should be kept inline.
UNWRAP_BODY_MACROS = {"section", "column", "multivote", "chart", "excerpt", "div"}
# Macros that render a live query in Confluence; no static equivalent exists.
DROP_MACROS = {
    "toc", "children", "pagetree", "attachments", "contributors", "listlabels",
    "roadmap", "anchor", "recently-updated", "labels", "spacedetails",
    "navmap", "blog-posts", "content-report-table", "detailssummary",
    "tasks-report-macro", "profile", "gallery", "livesearch", "include",
    "excerpt-include", "create-from-template", "pagetreesearch",
}
ADMONITION_MACROS = {"info", "note", "warning", "tip", "panel"}

stats = collections.Counter()
unknown_macros = collections.Counter()


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# --------------------------------------------------------------------------
# entities.xml
# --------------------------------------------------------------------------

def val(rec, key):
    v = rec.get(key)
    if v is None:
        return None
    return v[1] if v[0] == "VAL" else v[2]


def ref(rec, key):
    v = rec.get(key)
    return v[2] if (v is not None and v[0] == "REF") else None


def parse_entities(path):
    """Stream every <object> into {class: [record, ...]}."""
    out = collections.defaultdict(list)
    for _event, elem in ET.iterparse(path, events=("end",)):
        if elem.tag != "object":
            continue
        rec = {"_class": elem.get("class")}
        ident = elem.find("id")
        if ident is not None:
            rec["_id"] = (ident.text or "").strip()
        for p in elem.findall("property"):
            sub = p.find("id")
            if sub is not None:
                rec[p.get("name")] = ("REF", p.get("class"), (sub.text or "").strip())
            else:
                rec[p.get("name")] = ("VAL", p.text if p.text is not None else "")
        out[rec["_class"]].append(rec)
        elem.clear()
    return out


def parse_ts(text):
    """Confluence '2024-11-12 09:08:27.123' -> aware UTC datetime."""
    if not text:
        return None
    text = text.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def epoch(dt):
    """Vektor stores Drizzle timestamps as float-formatted seconds in TEXT."""
    return "%.1f" % dt.timestamp()


# --------------------------------------------------------------------------
# Slugs
# --------------------------------------------------------------------------

TRANSLIT = {
    "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
    "Ä": "Ae", "Ö": "Oe", "Ü": "Ue",
    "é": "e", "è": "e", "ê": "e", "á": "a", "à": "a",
    "í": "i", "ó": "o", "ú": "u", "ñ": "n", "ç": "c",
}


def slugify(text):
    """Vektor's slugify (utils.ts), with German transliteration first so
    umlauts survive as letters instead of collapsing into dashes."""
    for src, dst in TRANSLIT.items():
        text = text.replace(src, dst)
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower())
    slug = re.sub(r"^-+|-+$", "", slug)
    if slug in ("new",):
        slug = slug + "-1"
    return slug


class SlugPool(object):
    def __init__(self):
        self.used = set()

    def take(self, title, fallback):
        base = slugify(title or "") or slugify(fallback) or "page"
        if base not in self.used:
            self.used.add(base)
            return base
        n = 1
        while "%s-%d" % (base, n) in self.used:
            n += 1
        slug = "%s-%d" % (base, n)
        self.used.add(slug)
        return slug


def det_id(prefix, *parts):
    return "%s_%s" % (prefix, uuid.uuid5(ID_NAMESPACE, "|".join(str(p) for p in parts)))


# --------------------------------------------------------------------------
# Tolerant DOM for Confluence storage format
# --------------------------------------------------------------------------

class Node(object):
    __slots__ = ("tag", "attrs", "kids", "text")

    def __init__(self, tag, attrs=None, text=None):
        self.tag = tag          # None => text node
        self.attrs = attrs or {}
        self.kids = []
        self.text = text


CDATA_RE = re.compile(r"<!\[CDATA\[(.*?)\]\]\s*>", re.S)


def inline_cdata(body):
    """This export writes CDATA terminators as ']] >' (38k occurrences, zero
    plain ']]>'), which no HTML parser recognizes. Escape CDATA payloads into
    ordinary text before parsing; both terminator spellings are accepted."""
    def repl(m):
        stats["cdata"] += 1
        return html.escape(m.group(1), quote=False)
    body, _n = CDATA_RE.subn(repl, body)
    if "<![CDATA[" in body:
        # Unterminated section: escape the remainder of the body from that point.
        i = body.index("<![CDATA[")
        stats["cdata_unterminated"] += 1
        body = body[:i] + html.escape(body[i + 9:], quote=False)
    return body


class DomBuilder(HTMLParser):
    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict((k, v if v is not None else "") for k, v in attrs))
        self.stack[-1].kids.append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        node = Node(tag, dict((k, v if v is not None else "") for k, v in attrs))
        self.stack[-1].kids.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return
        # Stray close tag; the storage format is XML so this is rare.
        stats["stray_end_tag"] += 1

    def handle_data(self, data):
        if data:
            self.stack[-1].kids.append(Node(None, text=data))


def build_dom(body):
    p = DomBuilder()
    p.feed(inline_cdata(body))
    p.close()
    return p.root


def node_text(node):
    if node.tag is None:
        return node.text or ""
    return "".join(node_text(k) for k in node.kids)


# --------------------------------------------------------------------------
# Serialization
# --------------------------------------------------------------------------

def serialize(nodes):
    out = []
    for n in nodes:
        if n.tag is None:
            out.append(html.escape(n.text or "", quote=False))
            continue
        attrs = "".join(
            ' %s="%s"' % (k, html.escape(str(v), quote=True))
            for k, v in n.attrs.items() if v is not None
        )
        if n.tag in VOID_TAGS:
            out.append("<%s%s>" % (n.tag, attrs))
        else:
            out.append("<%s%s>%s</%s>" % (n.tag, attrs, serialize(n.kids), n.tag))
    return "".join(out)


def el(tag, attrs=None, kids=None, text=None):
    n = Node(tag, attrs, text)
    if kids:
        n.kids = kids
    return n


def txt(s):
    return Node(None, text=s)


SUBSTANTIVE_TAGS = re.compile(
    r"<(img|table|pre|file-attachment|video|figma-embed|hr|date-picker"
    r"|ticket-link|user-mention|ul|ol|blockquote|html-block|extension-view-block)\b")


def is_empty_html(markup):
    """True when converted content carries neither text nor any standalone node.

    Confluence container pages usually hold only a `children` or `pagetree`
    macro, which has no static equivalent and converts to nothing. Those pages
    are structure, not content."""
    if SUBSTANTIVE_TAGS.search(markup or ""):
        return False
    text = re.sub(r"<[^>]+>", " ", markup or "")
    text = html.unescape(text).replace("\xa0", " ")
    return not text.strip()


def confluence_page_url(space_key, title):
    """The canonical Confluence page URL, e.g.
    https://confluence.example.com/display/SVTECH/Technikmeeting

    Titles are encoded the way Confluence's own display URLs are: spaces as `+`,
    everything else percent-encoded, so `/`, `&` and `#` in a title survive
    instead of turning into path separators or a fragment. Returns None when no
    source instance was configured."""
    if not CONFLUENCE_BASE_URL:
        return None
    return "%s/display/%s/%s" % (
        CONFLUENCE_BASE_URL,
        quote(space_key or "", safe=""),
        quote_plus(title or ""),
    )


def confluence_page_id_url(content_id):
    if not CONFLUENCE_BASE_URL:
        return None
    return "%s/pages/viewpage.action?pageId=%s" % (
        CONFLUENCE_BASE_URL, quote(str(content_id), safe=""))


def confluence_space_url(space_key):
    if not CONFLUENCE_BASE_URL:
        return None
    return "%s/display/%s" % (CONFLUENCE_BASE_URL, quote(space_key or "", safe=""))


def external_link(href, label):
    return el("a", {"href": href, "target": "_blank",
                    "rel": "noopener noreferrer nofollow"}, [txt(label)])


def emoticon_icon_glyph(src):
    """Confluence renders some emoticons as an <img> served by the wiki itself.

    Those are inline glyphs, not document images: keeping them as images would
    put a block node in an inline run and leave the content depending on the old
    Confluence host staying reachable. Returns the replacement text, "" for a
    recognized-but-unmapped icon, or None when the src is a real image."""
    icon = re.search(r"/images/icons/emoticons/([\w-]+)\.\w+", src or "")
    if not icon:
        return None
    glyph = ICON_EMOTICONS.get(icon.group(1))
    if glyph is None:
        stats["emoticon_img_unknown_" + icon.group(1)] += 1
        return ""
    return glyph


def is_inline(node):
    return node.tag is None or node.tag in INLINE_TAGS


def is_blank_text(node):
    return node.tag is None and not (node.text or "").strip(" \t\r\n\xa0")


def wrap_blocks(kids):
    """Vektor requires block children in li / td / blockquote / column-item.
    Group runs of inline nodes into paragraphs and keep real blocks as-is."""
    kids = hoist_blocks(kids)
    out = []
    buf = []

    def flush():
        if not buf:
            return
        if all(is_blank_text(b) for b in buf):
            buf[:] = []
            return
        out.append(el("p", kids=list(buf)))
        buf[:] = []

    for k in kids:
        if is_inline(k):
            buf.append(k)
        else:
            flush()
            out.append(k)
    flush()
    return out or [el("p")]


def ensure_leading_paragraph(blocks):
    """listItem is `paragraph block*` and taskItem is `paragraph (taskList|block)*`,
    so both must start with a paragraph even when the source starts with a
    nested list."""
    if not blocks:
        return [el("p")]
    if blocks[0].tag != "p":
        return [el("p")] + blocks
    return blocks


def only_list_items(kids):
    """bulletList / orderedList accept `listItem+` and nothing else."""
    return [k for k in kids if k.tag == "li"]


def hoist_blocks(kids):
    """Lift block nodes out of inline wrappers.

    Confluence writes linked or bolded images as <p><a><img></a></p>. Vektor's
    image node is block-level, so the block has to come out of the inline chain.
    A wrapping link is not lost: it is re-emitted after the image, carrying the
    image's alt text."""
    out = []
    for k in kids:
        if k.tag is None or k.tag not in INLINE_TAGS:
            out.append(k)
            continue
        inner = hoist_blocks(k.kids)
        blocks = [c for c in inner if c.tag is not None and c.tag not in INLINE_TAGS]
        if not blocks:
            k.kids = inner
            out.append(k)
            continue
        stats["hoisted_block_from_inline"] += 1
        remaining = [c for c in inner if c not in blocks]
        out.extend(blocks)
        if k.tag == "a" and k.attrs.get("href"):
            label = "".join(node_text(c) for c in remaining).strip()
            if not label:
                label = next((b.attrs.get("alt") for b in blocks
                              if b.attrs.get("alt")), None) or k.attrs["href"]
            out.append(el("a", dict(k.attrs), [txt(label)]))
        elif remaining and not all(is_blank_text(c) for c in remaining):
            k.kids = remaining
            out.append(k)
    return out


def split_inline_container(tag, attrs, kids):
    """Split a node whose content model is `inline*` (paragraph, heading).

    Vektor's image / video / file-attachment / figma-embed / pre / table are
    block nodes, but Confluence nests them inside <p> and inside headings. Emit
    one container per run of inline content and lift each block to a sibling, so
    no block ever ends up in an inline context."""
    kids = hoist_blocks(kids)
    out = []
    buf = []

    def flush():
        if buf and not all(is_blank_text(b) for b in buf):
            out.append(el(tag, dict(attrs or {}), list(buf)))
        buf[:] = []

    for k in kids:
        if is_inline(k):
            buf.append(k)
        else:
            flush()
            out.append(k)
    flush()
    return out


def split_paragraph(kids):
    return split_inline_container("p", None, kids)


# --------------------------------------------------------------------------
# Converter
# --------------------------------------------------------------------------

class Converter(object):
    """Confluence storage-format DOM -> Vektor editor HTML."""

    def __init__(self, ctx):
        self.ctx = ctx          # resolution callbacks + page context

    # -- helpers ----------------------------------------------------------

    def kids(self, node):
        out = []
        for k in node.kids:
            out.extend(self.convert(k))
        return out

    def macro_params(self, node):
        params = {}
        body = None
        plain = None
        for k in node.kids:
            if k.tag == "ac:parameter":
                params[k.attrs.get("ac:name", "")] = k
            elif k.tag == "ac:rich-text-body":
                body = k
            elif k.tag == "ac:plain-text-body":
                plain = k
        return params, body, plain

    def param_text(self, params, name, default=""):
        p = params.get(name)
        return node_text(p).strip() if p is not None else default

    # -- entry ------------------------------------------------------------

    def convert(self, node):
        """Returns a list of output nodes."""
        if node.tag is None:
            return [node]
        tag = node.tag

        handler = getattr(self, "_t_" + tag.replace(":", "_").replace("-", "_"), None)
        if handler is not None:
            return handler(node)

        # Headings: Vektor supports h1-h4 only (HEADING_LEVELS).
        m = re.match(r"^h([1-6])$", tag)
        if m:
            level = min(int(m.group(1)), 4)
            if int(m.group(1)) > 4:
                stats["heading_clamped"] += 1
            # Headings are `inline*`, same as paragraphs: a nested block has to
            # become a sibling rather than a child.
            return split_inline_container("h%d" % level, None, self.kids(node))

        if tag in ("colgroup", "col", "ac:placeholder", "ac:macro-parameter"):
            stats["dropped_" + tag] += 1
            return []

        # Structural wrappers with no Vektor equivalent: keep the children.
        if tag in ("div", "thead", "tbody", "tfoot", "ac:layout", "ac:link-body",
                   "ac:plain-text-link-body", "ac:inline-comment-marker",
                   "ac:rich-text-body", "font", "center", "small", "big",
                   "address", "section", "article", "figure", "figcaption"):
            return self.kids(node)

        if tag in ("script", "style", "head", "title", "noscript", "object"):
            stats["dropped_" + tag] += 1
            return []

        # Pass-through tags the schema understands as-is.
        if tag in ("p", "ul", "ol", "li", "table", "tr", "th", "td", "strong",
                   "em", "u", "s", "code", "sup", "sub", "blockquote", "hr",
                   "br", "pre", "b", "i", "del", "strike", "span", "a", "img"):
            return self._passthrough(node)

        stats["unknown_tag_" + tag] += 1
        return self.kids(node)

    # -- generic pass-through --------------------------------------------

    def _passthrough(self, node):
        tag = node.tag
        # Normalize to the tag each mark spec renders.
        tag = {"b": "strong", "i": "em", "strike": "s", "del": "s"}.get(tag, tag)
        attrs = {}
        if tag == "a":
            href = node.attrs.get("href")
            if not href or href.strip().lower().startswith("javascript:"):
                stats["link_dropped"] += 1
                return self.kids(node)
            if CONFLUENCE_BASE_URL and href.startswith(CONFLUENCE_BASE_URL):
                stats["legacy_host_ref"] += 1
            attrs = {"href": href, "target": "_blank",
                     "rel": "noopener noreferrer nofollow"}
        elif tag == "span":
            style = node.attrs.get("style")
            # textStyle only carries colour; a span with anything else is noise.
            if style and re.search(r"(?:^|;)\s*(?:color|background-color)\s*:", style):
                attrs = {"style": style}
            else:
                return self.kids(node)
        elif tag == "img":
            src = node.attrs.get("src", "")
            if not src or src.startswith("data:"):
                stats["img_dropped"] += 1
                return []
            # Confluence renders some emoticons as an <img> served by the wiki
            # itself. Those are inline glyphs, not document images: keeping them
            # would put a block node in an inline run AND leave the content
            # depending on the old Confluence host staying up.
            glyph = emoticon_icon_glyph(src)
            if glyph is not None:
                stats["emoticon_img_inlined"] += 1
                return [txt(glyph)] if glyph else []
            attrs = {"src": src}
            for a in ("alt", "title", "width", "height"):
                if node.attrs.get(a):
                    attrs[a] = node.attrs[a]
        elif tag in ("th", "td"):
            for a in ("colspan", "rowspan"):
                if node.attrs.get(a):
                    attrs[a] = node.attrs[a]
            style = node.attrs.get("style", "")
            m = re.search(r"background-color\s*:\s*([^;]+)", style)
            if m:
                attrs["style"] = "background-color: %s" % m.group(1).strip()
        elif tag == "ol":
            if node.attrs.get("start"):
                attrs["start"] = node.attrs["start"]

        if tag in VOID_TAGS:
            return [el(tag, attrs)]

        kids = self.kids(node)

        if tag == "li":
            return [el("li", attrs, ensure_leading_paragraph(wrap_blocks(kids)))]
        if tag in ("ul", "ol"):
            items = only_list_items(kids)
            if not items:
                stats["empty_list_dropped"] += 1
                return []
            return [el(tag, attrs, items)]
        if tag in ("th", "td", "blockquote"):
            return [el(tag, attrs, wrap_blocks(kids))]
        if tag == "table":
            rows = [k for k in kids if k.tag == "tr"]
            if not rows:
                return []
            return [el("table", attrs, [el("tbody", kids=rows)])]
        if tag == "p":
            return split_paragraph(kids)
        if tag == "pre":
            code = "".join(node_text(k) for k in node.kids)
            return [el("pre", kids=[el("code", kids=[txt(code)])])]
        return [el(tag, attrs, kids)]

    # -- Confluence links -------------------------------------------------

    def _t_ac_link(self, node):
        target = None
        label_nodes = []
        for k in node.kids:
            if k.tag in ("ri:user", "ri:page", "ri:attachment", "ri:url",
                         "ri:space", "ri:content-entity", "ri:blog-post"):
                target = k
            elif k.tag in ("ac:plain-text-link-body", "ac:link-body"):
                label_nodes = k.kids
        label = "".join(node_text(k) for k in label_nodes).strip()

        if target is None:
            # A mention whose <ri:user> was stripped when the account was removed
            # from Confluence. The display name survives in the link body, so try
            # to recover the address from it before giving up on the mention.
            email = self.ctx["resolve_display_name"](label)
            if email:
                stats["mention_recovered_by_name"] += 1
                return [el("user-mention", {"email": email}, [txt("@" + label)])]
            stats["link_no_target"] += 1
            if label:
                self.ctx["unmatched_names"][label] += 1
                return [txt("@" + label)]
            return self.kids(node)

        if target.tag == "ri:user":
            return self._user_mention(target.attrs.get("ri:userkey", ""), label)

        if target.tag == "ri:page":
            title = target.attrs.get("ri:content-title", "")
            space = target.attrs.get("ri:space-key") or self.ctx["space_key"]
            slug = self.ctx["resolve_page"](space, title)
            text = label or title
            if slug:
                stats["page_link_resolved"] += 1
                return [el("a", {"href": "/%s/doc/%s" % (SPACE_SLUG, slug)},
                           [txt(text)])]
            # Not in this import (another space, or a page deleted before the
            # export). Point at the original Confluence page instead of losing
            # the reference to plain text.
            self.ctx["unresolved_pages"][(space, title)] += 1
            href = confluence_page_url(space, title) if title else None
            if href:
                stats["page_link_to_confluence"] += 1
                return [external_link(href, text or title)]
            stats["page_link_unresolved"] += 1
            return [txt(text)] if text else []

        if target.tag == "ri:attachment":
            url = self.ctx["resolve_attachment"](target)
            name = target.attrs.get("ri:filename", "")
            if url:
                stats["attachment_link"] += 1
                return [el("a", {"href": url, "target": "_blank",
                                 "rel": "noopener noreferrer nofollow"},
                           [txt(label or name)])]
            stats["attachment_link_missing"] += 1
            return [txt(label or name)] if (label or name) else []

        if target.tag == "ri:url":
            url = target.attrs.get("ri:value", "")
            if url:
                return [el("a", {"href": url, "target": "_blank",
                                 "rel": "noopener noreferrer nofollow"},
                           [txt(label or url)])]
            return []

        if target.tag == "ri:content-entity":
            slug = self.ctx["resolve_content_id"](
                target.attrs.get("ri:content-id", ""))
            if slug:
                stats["content_entity_link"] += 1
                return [el("a", {"href": "/%s/doc/%s" % (SPACE_SLUG, slug)},
                           [txt(label or slug)])]
            cid = target.attrs.get("ri:content-id")
            href = confluence_page_id_url(cid) if cid else None
            if href:
                stats["content_entity_to_confluence"] += 1
                return [external_link(href, label or cid)]
            stats["content_entity_unresolved"] += 1
            return [txt(label)] if label else []

        if target.tag == "ri:space":
            key = target.attrs.get("ri:space-key")
            href = confluence_space_url(key) if key else None
            if href:
                stats["space_link_to_confluence"] += 1
                return [external_link(href, label or key)]
            return [txt(label)] if label else []

        stats["link_target_" + target.tag] += 1
        return [txt(label)] if label else []

    def _user_mention(self, userkey, label):
        user = self.ctx["users"].get(userkey)
        if user is None:
            stats["mention_unknown_user"] += 1
            return [txt("@" + label)] if label else []
        name = label or user["display"]
        if user["email"]:
            stats["mention"] += 1
            return [el("user-mention", {"email": user["email"]},
                       [txt("@" + name)])]
        # No address to mention against; keep the name as plain text.
        stats["mention_no_email"] += 1
        return [txt("@" + name)]

    # -- Confluence media -------------------------------------------------

    def _t_ac_image(self, node):
        src = None
        alt = node.attrs.get("ac:alt") or node.attrs.get("ac:title") or None
        for k in node.kids:
            if k.tag == "ri:attachment":
                src = self.ctx["resolve_attachment"](k)
                alt = alt or k.attrs.get("ri:filename")
            elif k.tag == "ri:url":
                src = k.attrs.get("ri:value")
        if not src:
            stats["image_unresolved"] += 1
            return []
        # <ac:image> can also wrap an emoticon icon served by the old wiki.
        glyph = emoticon_icon_glyph(src)
        if glyph is not None:
            stats["emoticon_img_inlined"] += 1
            return [txt(glyph)] if glyph else []
        attrs = {"src": src}
        if alt:
            attrs["alt"] = alt
        width = node.attrs.get("ac:width")
        if width:
            attrs["width"] = width
            attrs["style"] = "width: %spx" % width if width.isdigit() else "width: %s" % width
        height = node.attrs.get("ac:height")
        if height:
            attrs["height"] = height
        stats["image"] += 1
        return [el("img", attrs)]

    def _t_ac_emoticon(self, node):
        name = node.attrs.get("ac:name", "")
        glyph = EMOTICONS.get(name)
        if glyph is None:
            fallback = node.attrs.get("ac:emoji-fallback")
            glyph = fallback if fallback else ""
            if not glyph:
                stats["emoticon_unknown_" + name] += 1
        stats["emoticon"] += 1
        return [txt(glyph)] if glyph else []

    def _t_time(self, node):
        d = node.attrs.get("datetime", "")
        if re.match(r"^\d{4}-\d{2}-\d{2}$", d):
            stats["date_picker"] += 1
            return [el("date-picker", {"data-date": d})]
        return [txt(d)] if d else []

    # -- tasks ------------------------------------------------------------

    def _t_ac_task_list(self, node):
        items = []
        for k in node.kids:
            if k.tag != "ac:task":
                continue
            status = ""
            body = None
            for c in k.kids:
                if c.tag == "ac:task-status":
                    status = node_text(c).strip()
                elif c.tag == "ac:task-body":
                    body = c
            kids = self.kids(body) if body is not None else []
            checked = "true" if status == "complete" else "false"
            checkbox_attrs = {"type": "checkbox"}
            if checked == "true":
                checkbox_attrs["checked"] = ""
            items.append(el("li", {"data-type": "taskItem", "data-checked": checked}, [
                el("label", {"contenteditable": "false"},
                   [el("input", checkbox_attrs)]),
                el("div", kids=ensure_leading_paragraph(wrap_blocks(kids))),
            ]))
            stats["task"] += 1
        if not items:
            return []
        return [el("ul", {"data-type": "taskList"}, items)]

    # -- layout -----------------------------------------------------------

    def _t_ac_layout_section(self, node):
        cells = [k for k in node.kids if k.tag == "ac:layout-cell"]
        if not cells:
            return self.kids(node)
        # A single-cell section is not a column layout, just a wrapper.
        if len(cells) == 1:
            stats["layout_single"] += 1
            return self.kids(cells[0])
        items = []
        for c in cells:
            kids = self.kids(c)
            items.append(el("div", {"data-type": "column-item"}, wrap_blocks(kids)))
        stats["layout_columns"] += 1
        return [el("div", {"data-type": "column-layout",
                           "data-columns": str(len(items))}, items)]

    def _t_ac_layout_cell(self, node):
        return self.kids(node)

    # -- macros -----------------------------------------------------------

    def _t_ac_structured_macro(self, node):
        return self._macro(node)

    def _t_ac_macro(self, node):
        return self._macro(node)

    def _macro(self, node):
        name = (node.attrs.get("ac:name") or "").lower()
        params, body, plain = self.macro_params(node)
        stats["macro_" + (name or "unnamed")] += 1

        if name == "status":
            title = self.param_text(params, "title")
            if not title:
                return []
            colour = (self.param_text(params, "colour") or "grey").lower()
            bg, fg = STATUS_COLOURS.get(colour, STATUS_COLOURS["grey"])
            return [el("span", {"style": "background-color: %s; color: %s" % (bg, fg)},
                       [txt(title)])]

        if name == "code":
            language = self.param_text(params, "language").lower()
            source = node_text(plain) if plain is not None else ""
            code_attrs = {}
            if language and re.match(r"^[a-z0-9+#-]+$", language):
                code_attrs["class"] = "language-%s" % language
            return [el("pre", kids=[el("code", code_attrs, [txt(source)])])]

        if name in ("noformat", "panel-code"):
            return [el("pre", kids=[el("code", kids=[txt(node_text(plain) if plain is not None else "")])])]

        if name == "view-file":
            p = params.get("name")
            att = None
            if p is not None:
                for k in p.kids:
                    if k.tag == "ri:attachment":
                        att = k
            if att is None:
                stats["view_file_no_target"] += 1
                return []
            url = self.ctx["resolve_attachment"](att)
            filename = att.attrs.get("ri:filename", "file")
            if not url:
                stats["view_file_missing"] += 1
                return [el("p", kids=[txt(filename)])]
            return [el("file-attachment", {"src": url, "filename": filename})]

        if name == "widget":
            p = params.get("url")
            url = ""
            if p is not None:
                for k in p.kids:
                    if k.tag == "ri:url":
                        url = k.attrs.get("ri:value", "")
                if not url:
                    url = node_text(p).strip()
            if not url:
                return []
            return [el("p", kids=[el("a", {"href": url, "target": "_blank",
                                           "rel": "noopener noreferrer nofollow"},
                                      [txt(url)])])]

        if name == "jira":
            key = self.param_text(params, "key")
            if not key:
                return []
            return [el("ticket-link", {"data-ticket-id": key}, [txt(key)])]

        if name in ADMONITION_MACROS:
            title = self.param_text(params, "title")
            inner = self.kids(body) if body is not None else []
            blocks = wrap_blocks(inner)
            if title:
                blocks = [el("p", kids=[el("strong", kids=[txt(title)])])] + blocks
            return [el("blockquote", kids=blocks)]

        if name == "expand":
            title = self.param_text(params, "title")
            inner = wrap_blocks(self.kids(body) if body is not None else [])
            head = [el("p", kids=[el("strong", kids=[txt(title)])])] if title else []
            return head + inner

        if name in UNWRAP_BODY_MACROS:
            if body is not None:
                return self.kids(body)
            return []

        if name in DROP_MACROS:
            stats["macro_dropped"] += 1
            return []

        unknown_macros[name] += 1
        # Unknown macro: keep any real body content rather than losing it.
        if body is not None:
            return self.kids(body)
        if plain is not None:
            text = node_text(plain)
            return [el("p", kids=[txt(text)])] if text.strip() else []
        return []

    # -- bare ri: elements (outside ac:link) ------------------------------

    def _t_ri_attachment(self, node):
        url = self.ctx["resolve_attachment"](node)
        name = node.attrs.get("ri:filename", "file")
        if url:
            return [el("a", {"href": url, "target": "_blank",
                             "rel": "noopener noreferrer nofollow"}, [txt(name)])]
        return [txt(name)]

    def _t_ri_user(self, node):
        return self._user_mention(node.attrs.get("ri:userkey", ""), "")

    def _t_ri_url(self, node):
        url = node.attrs.get("ri:value", "")
        if not url:
            return []
        return [el("a", {"href": url, "target": "_blank",
                         "rel": "noopener noreferrer nofollow"}, [txt(url)])]

    def _t_ri_page(self, node):
        title = node.attrs.get("ri:content-title", "")
        space = node.attrs.get("ri:space-key") or self.ctx["space_key"]
        slug = self.ctx["resolve_page"](space, title)
        if slug:
            return [el("a", {"href": "/%s/doc/%s" % (SPACE_SLUG, slug)}, [txt(title)])]
        if title:
            self.ctx["unresolved_pages"][(space, title)] += 1
            href = confluence_page_url(space, title)
            if href:
                stats["page_link_to_confluence"] += 1
                return [external_link(href, title)]
            stats["page_link_unresolved"] += 1
            return [txt(title)]
        return []

    def _t_ri_space(self, node):
        key = node.attrs.get("ri:space-key")
        href = confluence_space_url(key) if key else None
        if href:
            stats["space_link_to_confluence"] += 1
            return [external_link(href, key)]
        return []

    def _t_ri_content_entity(self, node):
        return []

    def _t_ac_parameter(self, node):
        # Only reached for stray parameters outside a macro.
        return []


def convert_body(body, ctx):
    """Confluence storage XHTML -> Vektor document HTML."""
    if not body or not body.strip():
        return "<p></p>"
    root = build_dom(body)
    conv = Converter(ctx)
    kids = []
    for k in root.kids:
        kids.extend(conv.convert(k))
    # Document content must be a sequence of blocks.
    blocks = wrap_blocks(kids)
    out = serialize(blocks)
    return out if out.strip() else "<p></p>"


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main(argv=None):
    global EXPORT_ROOT, STAGING_DIR, STAGING_DB, STAGING_UPLOADS
    global SPACE_NAME, SPACE_SLUG, DEFAULT_USER_ID, USER_MAP_PATH
    global CONFLUENCE_BASE_URL

    args = parse_args(argv)
    EXPORT_ROOT = os.path.abspath(args.export_dir)
    STAGING_DIR = os.path.abspath(args.out)
    STAGING_DB = os.path.join(STAGING_DIR, "staging.db")
    STAGING_UPLOADS = os.path.join(STAGING_DIR, "uploads")
    DEFAULT_USER_ID = args.owner
    USER_MAP_PATH = args.users
    CONFLUENCE_BASE_URL = args.confluence_url.rstrip("/")

    entities = os.path.join(EXPORT_ROOT, "entities.xml")
    if not os.path.exists(entities):
        raise SystemExit("entities.xml not found at %s" % entities)

    log("parsing entities.xml ...")
    O = parse_entities(entities)
    log("  %d objects" % sum(len(v) for v in O.values()))

    # ---- users ----
    users = {}
    for u in O.get("ConfluenceUserImpl", []):
        name = val(u, "name") or ""
        email = val(u, "email") or ""
        if not email and "@" in name:
            email = name
        display = name.split("@")[0].replace(".", " ").title() if "@" in name else name
        users[u["_id"]] = {
            "name": name,
            "email": email.strip().lower() or None,
            "display": display or name,
        }
    log("  %d users (%d with email)"
        % (len(users), sum(1 for u in users.values() if u["email"])))

    # ---- pages ----
    pages = O.get("Page", [])
    by_id = dict((p["_id"], p) for p in pages)
    live = [p for p in pages
            if ref(p, "originalVersion") is None
            and val(p, "contentStatus") == "current"]
    live_ids = set(p["_id"] for p in live)

    history = collections.defaultdict(list)
    for p in pages:
        root_id = ref(p, "originalVersion")
        if root_id in live_ids:
            history[root_id].append(p)

    bodies = {}
    for b in O.get("BodyContent", []):
        bodies[ref(b, "content")] = val(b, "body") or ""

    space = O["Space"][0]
    space_key = val(space, "key")
    SPACE_NAME = args.space_name or val(space, "name") or space_key
    SPACE_SLUG = args.space_slug or slugify(space_key)
    globals()["SPACE_NAME"] = SPACE_NAME
    globals()["SPACE_SLUG"] = SPACE_SLUG
    if not SPACE_SLUG:
        raise SystemExit("could not derive a space slug; pass --space-slug")
    # Derived here, not in stage 2: upload URLs are embedded in document HTML,
    # so the final space id has to be known before any body is converted.
    space_id = det_id("space", "space", space_key)
    log("  space %s -> %r (slug %s)" % (space_key, SPACE_NAME, SPACE_SLUG))

    # ---- tree + slugs (deterministic order) ----
    kids_of = collections.defaultdict(list)
    roots = []
    for p in live:
        parent = ref(p, "parent")
        if parent in live_ids:
            kids_of[parent].append(p)
        else:
            roots.append(p)

    def sort_key(p):
        pos = val(p, "position")
        return (int(pos) if pos not in (None, "") else 99999,
                (val(p, "lowerTitle") or ""))

    def walk_tree(assign_slug):
        """Depth-first walk in Confluence display order. `assign_slug` decides
        whether a page takes a slug, so the same walk can run before and after
        the empty-container pages are known."""
        walk_order = []
        pool = SlugPool()
        slugs = {}

        def visit(p, depth):
            walk_order.append((p, depth))
            if assign_slug(p):
                slugs[p["_id"]] = pool.take(val(p, "title"),
                                            "page-%s" % p["_id"])
            for c in sorted(kids_of[p["_id"]], key=sort_key):
                visit(c, depth + 1)

        for r in sorted(roots, key=sort_key):
            visit(r, 0)
        return walk_order, slugs

    full_order, provisional_slugs = walk_tree(lambda p: True)
    log("  %d live pages, %d in tree" % (len(live), len(full_order)))
    if len(full_order) != len(live):
        raise SystemExit("tree walk missed pages (cycle?)")

    # ---- categories: every first-level page under the space home ----
    first_level = []
    for r in sorted(roots, key=sort_key):
        for c in sorted(kids_of[r["_id"]], key=sort_key):
            first_level.append(c)

    categories = []
    cat_pool = SlugPool()
    category_of = {}          # page id -> category slug
    for i, p in enumerate(first_level):
        name = val(p, "title")
        cslug = cat_pool.take(name, "category-%s" % p["_id"])
        categories.append({
            "id": det_id("category", "page", p["_id"]),
            "name": name,
            "slug": cslug,
            "order": i,
        })
        # Assign the category to the first-level page and every descendant.
        stack = [p]
        while stack:
            cur = stack.pop()
            category_of[cur["_id"]] = cslug
            stack.extend(kids_of[cur["_id"]])
    log("  %d categories" % len(categories))

    # ---- attachments -> content-addressable uploads ----
    if os.path.isdir(STAGING_UPLOADS):
        shutil.rmtree(STAGING_UPLOADS)
    os.makedirs(STAGING_UPLOADS)

    cp_by_content = collections.defaultdict(dict)
    for cp in O.get("ContentProperty", []):
        cp_by_content[ref(cp, "content")][val(cp, "name")] = (
            val(cp, "stringValue") or val(cp, "longValue"))

    uploads = []                      # rows for the file table
    att_by_page_name = {}             # (container_id, lower name) -> url
    att_by_name = {}                  # lower name -> url (cross-page fallback)
    att_missing = 0

    attachments = O.get("Attachment", [])
    for a in attachments:
        if ref(a, "originalVersion") is not None:
            continue                  # only the current version is referenced
        aid = a["_id"]
        container = ref(a, "containerContent")
        version = val(a, "version")
        filename = val(a, "title") or aid
        src = os.path.join(EXPORT_ROOT, "attachments", container, aid, version)
        if not os.path.exists(src):
            att_missing += 1
            log("  MISSING attachment file: %s (%s)" % (src, filename))
            continue
        with open(src, "rb") as fh:
            data = fh.read()
        digest = hashlib.sha256(data).hexdigest()
        ext = os.path.splitext(filename)[1].lstrip(".").lower()
        ext = re.sub(r"[^a-z0-9]", "", ext) or "bin"
        key = "%s/%s.%s" % (digest[:2], digest, ext)
        dest = os.path.join(STAGING_UPLOADS, key)
        if not os.path.exists(dest):
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copyfile(src, dest)
        url = "/api/v1/spaces/%s/uploads/%s" % (space_id, key)
        props = cp_by_content.get(aid, {})
        uploads.append({
            "key": key,
            "page_id": container if container in live_ids else None,
            "original_name": filename,
            "mime_type": props.get("MEDIA_TYPE"),
            "url": url,
        })
        att_by_page_name[(container, filename.lower())] = url
        att_by_name.setdefault(filename.lower(), url)

    log("  %d uploads staged (%d source files missing)" % (len(uploads), att_missing))

    # ---- resolution callbacks ----
    # Rebuilt in place once the empty container pages are known, so the closures
    # below keep working against the final slugs.
    title_index = {}
    content_id_index = {}

    def rebuild_indexes(slug_map):
        title_index.clear()
        content_id_index.clear()
        for pid, slug in slug_map.items():
            page = by_id[pid]
            title_index[(space_key.lower(),
                         (val(page, "title") or "").lower())] = slug
            content_id_index[pid] = slug

    rebuild_indexes(provisional_slugs)

    def resolve_page(space, title):
        if not title:
            return None
        return title_index.get(((space or space_key).lower(), title.lower()))

    def resolve_content_id(cid):
        return content_id_index.get(cid)

    ctx_page = {"id": None}

    def resolve_attachment(node):
        filename = (node.attrs.get("ri:filename") or "").lower()
        if not filename:
            return None
        # An explicit content-entity child points at another page's attachment.
        for k in node.kids:
            if k.tag == "ri:content-entity":
                cid = k.attrs.get("ri:content-id")
                url = att_by_page_name.get((cid, filename))
                if url:
                    return url
        url = att_by_page_name.get((ctx_page["id"], filename))
        if url:
            return url
        return att_by_name.get(filename)

    # Confluence stores only the login (an address) for each user, so a display
    # name is matched back by the "<initial>.<lastname>" shape those logins use.
    # Ambiguous shapes are dropped rather than guessed at.
    local_index = collections.defaultdict(list)
    for u in users.values():
        if u["email"]:
            local_index[u["email"].split("@")[0].lower()].append(u["email"])

    def display_to_local(label):
        parts = [p for p in re.split(r"\s+", (label or "").strip()) if p]
        if len(parts) < 2:
            return None
        norm = []
        for p in parts:
            for src, dst in TRANSLIT.items():
                p = p.replace(src, dst)
            norm.append(re.sub(r"[^a-z]", "", p.lower()))
        if not norm[0] or not norm[-1]:
            return None
        return "%s.%s" % (norm[0][0], norm[-1])

    def resolve_display_name(label):
        local = display_to_local(label)
        if not local:
            return None
        hits = local_index.get(local, [])
        return hits[0] if len(hits) == 1 else None

    ctx = {
        "users": users,
        "space_key": space_key,
        "resolve_page": resolve_page,
        "resolve_content_id": resolve_content_id,
        "resolve_attachment": resolve_attachment,
        "resolve_display_name": resolve_display_name,
        "unresolved_pages": collections.Counter(),
        "unmatched_names": collections.Counter(),
    }

    # ---- drop empty container pages -----------------------------------------
    # The space home and the first-level pages exist in Confluence only to hold
    # children. In Vektor a category already plays that role, so an empty one is
    # redundant: drop the document and lift its children a level, keeping the
    # category assignment that already covers the whole subtree.
    def newest_body(page):
        chain = sorted(history.get(page["_id"], []),
                       key=lambda q: int(val(q, "version") or 0))
        chain.append(page)
        for entry in reversed(chain):
            body = bodies.get(entry["_id"])
            if body is not None:
                return body
        return None

    def renders_empty(page):
        body = newest_body(page)
        if body is None:
            return True
        ctx_page["id"] = page["_id"]
        return is_empty_html(convert_body(body, ctx))

    container_candidates = list(roots) + list(first_level)
    dropped = set()
    for p in container_candidates:
        if renders_empty(p):
            dropped.add(p["_id"])
    # Counters from the probe pass would otherwise double-count.
    stats.clear()
    ctx["unresolved_pages"].clear()
    ctx["unmatched_names"].clear()

    order = [p for p, _d in full_order if p["_id"] not in dropped]
    _kept_order, slug_of = walk_tree(lambda p: p["_id"] not in dropped)
    rebuild_indexes(slug_of)
    doc_id_of = dict((p["_id"], det_id("doc", "page", p["_id"])) for p in order)

    def effective_parent(page):
        """Nearest ancestor that survived, skipping dropped containers."""
        parent_id = ref(page, "parent")
        while parent_id in dropped:
            parent_id = ref(by_id[parent_id], "parent")
        return doc_id_of.get(parent_id)

    if dropped:
        log("  dropped %d empty container page(s); their children move up a level:"
            % len(dropped))
        for p in container_candidates:
            if p["_id"] in dropped:
                log("    %-44s (%d children lifted)"
                    % (val(p, "title"), len(kids_of[p["_id"]])))
        kept_containers = [val(p, "title") for p in first_level
                           if p["_id"] not in dropped]
        if kept_containers:
            log("  kept as documents (they have content): %s"
                % ", ".join(kept_containers))
    log("  %d documents after dropping empty containers" % len(order))

    # ---- staging db ----
    if not os.path.isdir(STAGING_DIR):
        os.makedirs(STAGING_DIR)
    if os.path.exists(STAGING_DB):
        os.remove(STAGING_DB)
    db = sqlite3.connect(STAGING_DB)
    db.executescript("""
        CREATE TABLE space (id TEXT, name TEXT, slug TEXT, created_by TEXT,
                            created_at TEXT, updated_at TEXT);
        CREATE TABLE doc (id TEXT PRIMARY KEY, slug TEXT, title TEXT,
                          category TEXT, parent_id TEXT, content TEXT,
                          current_rev INTEGER, created_at TEXT, updated_at TEXT,
                          created_by TEXT, source_page_id TEXT, position INTEGER);
        CREATE TABLE rev (id TEXT, document_id TEXT, rev INTEGER, slug TEXT,
                          html TEXT, parent_rev INTEGER, message TEXT,
                          created_at TEXT, created_by TEXT);
        CREATE TABLE cat (id TEXT, name TEXT, slug TEXT, "order" INTEGER,
                          created_at TEXT, updated_at TEXT);
        CREATE TABLE upload (key TEXT, document_id TEXT, original_name TEXT,
                             mime_type TEXT, url TEXT, updated_at TEXT);
        CREATE TABLE acl_row (resource_type TEXT, resource_id TEXT, user_id TEXT,
                              group_id TEXT, permission TEXT, created_at TEXT,
                              updated_at TEXT);
    """)

    space_created = parse_ts(val(space, "creationDate")) or datetime.now(timezone.utc)
    space_updated = parse_ts(val(space, "lastModificationDate")) or space_created
    db.execute("INSERT INTO space VALUES (?,?,?,?,?,?)",
               (space_id, SPACE_NAME, SPACE_SLUG, DEFAULT_USER_ID,
                epoch(space_created), epoch(space_updated)))

    for c in categories:
        db.execute('INSERT INTO cat VALUES (?,?,?,?,?,?)',
                   (c["id"], c["name"], c["slug"], c["order"],
                    epoch(space_created), epoch(space_updated)))

    def user_for(rec, key):
        ukey = ref(rec, key)
        u = users.get(ukey)
        if u and u["email"]:
            mapped = ctx["user_map"].get(u["email"])
            if mapped:
                return mapped
        return DEFAULT_USER_ID

    # Vektor user ids by lowercase email, so imported content keeps its author
    # wherever the account already exists.
    ctx["user_map"] = {}
    if USER_MAP_PATH:
        if not os.path.exists(USER_MAP_PATH):
            raise SystemExit("--users file not found: %s" % USER_MAP_PATH)
        with open(USER_MAP_PATH) as fh:
            ctx["user_map"] = dict(
                (k.lower(), v) for k, v in json.load(fh).items())
        matched = sum(1 for u in users.values()
                      if u["email"] and u["email"] in ctx["user_map"])
        log("  %d vektor users for email mapping; %d of %d Confluence users matched"
            % (len(ctx["user_map"]), matched, len(users)))
    else:
        log("  no --users map: all content is attributed to %s" % DEFAULT_USER_ID)

    empty_docs = 0
    total_revs = 0
    revs_without_body = 0

    # --page-limit / --max-revisions keep smoke tests fast; omit both for a full
    # import.
    page_limit = args.page_limit or len(order)
    max_revs = args.max_revisions
    if page_limit < len(order) or max_revs:
        log("  LIMITED RUN: pages<=%d revs_per_page<=%s"
            % (page_limit, max_revs or "all"))
    order = order[:page_limit]

    for idx, p in enumerate(order):
        pid = p["_id"]
        ctx_page["id"] = pid
        doc_id = doc_id_of[pid]
        slug = slug_of[pid]
        title = val(p, "title") or slug

        created = parse_ts(val(p, "creationDate")) or space_created
        updated = parse_ts(val(p, "lastModificationDate")) or created

        # Version chain: historical versions then the current one, ordered by
        # Confluence version number. Revs are renumbered 1..N contiguously.
        chain = sorted(history.get(pid, []),
                       key=lambda q: int(val(q, "version") or 0))
        chain.append(p)
        if max_revs and len(chain) > max_revs:
            # Keep the newest versions: the current one must always survive.
            chain = chain[-max_revs:]

        rev_rows = []
        rev_no = 0
        for entry in chain:
            body = bodies.get(entry["_id"])
            if body is None:
                revs_without_body += 1
                continue
            ctx_page["id"] = pid
            html_out = convert_body(body, ctx)
            rev_no += 1
            ts = (parse_ts(val(entry, "lastModificationDate"))
                  or parse_ts(val(entry, "creationDate")) or created)
            comment = (val(entry, "versionComment") or "").strip()
            message = "Confluence v%s" % (val(entry, "version") or "?")
            if comment:
                message += " - " + comment
            rev_rows.append({
                "id": det_id("rev", "page", entry["_id"], rev_no),
                "rev": rev_no,
                "html": html_out,
                "parent_rev": rev_no - 1 if rev_no > 1 else None,
                "message": message,
                "created_at": epoch(ts),
                "created_by": user_for(entry, "lastModifier"),
            })

        if rev_rows:
            content = rev_rows[-1]["html"]
            current_rev = rev_rows[-1]["rev"]
        else:
            content = "<p></p>"
            current_rev = 0
            empty_docs += 1

        db.execute("INSERT INTO doc VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
            doc_id, slug, title, category_of.get(pid),
            effective_parent(p), content, current_rev,
            epoch(created), epoch(updated), user_for(p, "creator"), pid, idx,
        ))
        for r in rev_rows:
            db.execute("INSERT INTO rev VALUES (?,?,?,?,?,?,?,?,?)", (
                r["id"], doc_id, r["rev"], slug, r["html"], r["parent_rev"],
                r["message"], r["created_at"], r["created_by"],
            ))
        total_revs += len(rev_rows)

        if (idx + 1) % 25 == 0:
            log("  converted %d/%d pages (%d revisions)"
                % (idx + 1, len(order), total_revs))
            db.commit()

    for u in uploads:
        db.execute("INSERT INTO upload VALUES (?,?,?,?,?,?)", (
            u["key"], doc_id_of.get(u["page_id"]), u["original_name"],
            u["mime_type"], u["url"], epoch(space_updated),
        ))

    db.execute("INSERT INTO acl_row VALUES (?,?,?,?,?,?,?)", (
        "space", space_id, DEFAULT_USER_ID, None, "owner",
        epoch(space_created), epoch(space_created),
    ))

    db.commit()
    db.close()

    # ---- report ----
    log("")
    log("=== conversion summary ===")
    log("  space id            %s" % space_id)
    log("  documents           %d" % len(order))
    log("  revisions           %d" % total_revs)
    log("  categories          %d" % len(categories))
    log("  uploads             %d" % len(uploads))
    log("  empty documents     %d" % empty_docs)
    log("  versions w/o body   %d" % revs_without_body)
    log("")
    log("  conversion counters:")
    for k, v in sorted(stats.items(), key=lambda kv: -kv[1]):
        log("    %-34s %d" % (k, v))
    if unknown_macros:
        log("  UNKNOWN MACROS (body kept):")
        for k, v in unknown_macros.most_common():
            log("    %-34s %d" % (k, v))

    unresolved = ctx["unresolved_pages"]
    if unresolved:
        other = sum(n for (s, _t), n in unresolved.items()
                    if (s or "").upper() != space_key.upper())
        log("")
        log("  page links not resolvable in the import: %d refs, %d distinct targets%s"
            % (sum(unresolved.values()), len(unresolved),
               " (repointed to %s)" % CONFLUENCE_BASE_URL
               if CONFLUENCE_BASE_URL else " (kept as plain text)"))
        log("    %d of them target spaces not in this export" % other)
        for (s, t), n in unresolved.most_common(12):
            log("    %-14s %-48s %d" % (s, t[:48], n))
    if stats.get("legacy_host_ref"):
        log("")
        log("  NOTE: %d hyperlink(s) already pointed at %s in the source."
            % (stats["legacy_host_ref"], CONFLUENCE_BASE_URL))
        log("        They are kept verbatim and break when that host goes away.")
    if ctx["unmatched_names"]:
        log("")
        log("  mentions kept as plain text (no address recoverable): %d"
            % sum(ctx["unmatched_names"].values()))
        for k, v in ctx["unmatched_names"].most_common(8):
            log("    %-40s %d" % (k, v))

    with open(os.path.join(STAGING_DIR, "report.json"), "w") as fh:
        json.dump({
            "space_id": space_id,
            "documents": len(order),
            "revisions": total_revs,
            "categories": [c["slug"] for c in categories],
            "uploads": len(uploads),
            "empty_documents": empty_docs,
            "versions_without_body": revs_without_body,
            "counters": dict(stats),
            "unknown_macros": dict(unknown_macros),
            "unresolved_page_links": dict(
                ("%s:%s" % (s, t), n) for (s, t), n in ctx["unresolved_pages"].items()),
            "unmatched_mention_names": dict(ctx["unmatched_names"]),
        }, fh, indent=2, sort_keys=True)


if __name__ == "__main__":
    main()
