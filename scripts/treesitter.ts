const { Language, Parser } = require("web-tree-sitter");

await Parser.init();

const parser = new Parser();

const Languages = {
  // TypeScript: await Language.load('./tree-sitter-typescript.wasm'),
  HTML: await Language.load(import.meta.dir + "/tree-sitter-html.wasm"),
};

parser.setLanguage(Languages.HTML);

const tree = parser.parse(await Bun.file(process.argv[2] || "").text());

const MAX_WIDTH = 100;

function format(node: any, depth = 0, ind = "  "): string {
  const indent = ind.repeat(depth);
  const type = node.type;

  // HTML text nodes
  if (type === "text" || type === "raw_text") {
    const text = node.text.trim();
    return text ? indent + text + "\n" : "";
  }

  // Leaf statements
  if (type === "doctype" || type === "comment") {
    return indent + node.text + "\n";
  }

  // HTML elements
  if (type === "element" || type === "script_element" || type === "style_element") {
    let start = "",
      end = "",
      content = "",
      hasContent = false;
    for (const c of node.children) {
      const ct = c.type;
      if (ct === "start_tag" || ct === "self_closing_tag") start = c.text;
      else if (ct === "end_tag") end = c.text;
      else {
        const f = format(c, depth + 1, ind);
        if (f) {
          content += f;
          hasContent = true;
        }
      }
    }
    if (!hasContent) return indent + start + end + "\n";
    // Keep short content on single line
    const trimmed = content.trim();
    const singleLine = indent + start + trimmed + end;
    if (trimmed.indexOf("\n") === -1 && singleLine.length <= MAX_WIDTH) {
      return singleLine + "\n";
    }
    return indent + start + "\n" + content + indent + end + "\n";
  }

  // Statement-level nodes
  const statements = [
    "import_statement",
    "export_statement",
    "lexical_declaration",
    "variable_declaration",
    "function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "expression_statement",
    "return_statement",
    "throw_statement",
    "if_statement",
    "for_statement",
    "for_in_statement",
    "for_of_statement",
    "while_statement",
    "do_statement",
    "switch_statement",
    "try_statement",
    "break_statement",
    "continue_statement",
    "public_field_definition",
    "property_signature",
    "method_signature",
    "method_definition",
    "abstract_method_signature",
    "abstract_class_declaration",
  ];

  // Block containers
  const blocks = [
    "statement_block",
    "class_body",
    "interface_body",
    "enum_body",
    "object_type",
    "switch_body",
  ];

  if (type === "program") {
    let r = "";
    for (const c of node.children) r += format(c, depth, ind);
    return r;
  }

  if (blocks.indexOf(type) !== -1) {
    let r = "{\n";
    for (const c of node.children) {
      if (c.type === "{" || c.type === "}") continue;
      r += format(c, depth + 1, ind);
    }
    return r + indent + "}";
  }

  if (statements.indexOf(type) !== -1) {
    let blockChild = null;
    for (const c of node.children) {
      if (blocks.indexOf(c.type) !== -1 || c.type === "else_clause") {
        blockChild = c;
        break;
      }
    }

    if (blockChild) {
      let before = "",
        after = "";
      for (const c of node.children) {
        if (blocks.indexOf(c.type) !== -1) after += format(c, depth, ind);
        else if (c.type === "else_clause") after += format(c, depth, ind);
        else if (after === "") before += c.text + " ";
      }
      const beforeTrimmed = before.trim();
      if (indent.length + beforeTrimmed.length > MAX_WIDTH) {
        return wrapStatement(node, indent, ind) + "\n";
      }
      return indent + beforeTrimmed + " " + after.trim() + "\n";
    }

    const line = node.text.replace(/\s+/g, " ").trim();
    if (indent.length + line.length <= MAX_WIDTH) {
      return indent + line + "\n";
    }
    return indent + wrapStatement(node, indent, ind) + "\n";
  }

  if (type === "else_clause") {
    let r = " else ";
    for (const c of node.children) {
      if (c.type === "else") continue;
      if (c.type === "statement_block") r += format(c, depth, ind).trim();
      else if (c.type === "if_statement") r += format(c, depth, ind).trimStart();
      else r += format(c, depth, ind);
    }
    return r;
  }

  if (type === "switch_case" || type === "switch_default") {
    let label = "",
      body = "",
      pastColon = false;
    for (const c of node.children) {
      if (c.type === ":") {
        label = label.trimEnd() + ":";
        pastColon = true;
      } else if (!pastColon) label += c.text + " ";
      else body += format(c, depth + 1, ind);
    }
    return indent + label.trim() + "\n" + body;
  }

  let r = "";
  for (const c of node.children) r += format(c, depth, ind);
  return r;
}

function wrapStatement(node: any, indent: string, ind: string): string {
  const t = node.type;

  // Handle function/method parameters
  if (t === "function_declaration" || t === "method_definition") {
    return wrapFunction(node, indent, ind);
  }

  // Default: just return normalized text
  return node.text.replace(/\s+/g, " ").trim();
}

function wrapFunction(node: any, indent: string, ind: string): string {
  let result = "";
  const paramIndent = indent + ind;

  for (const c of node.children) {
    if (c.type === "formal_parameters") {
      result += "(\n";
      const params: string[] = [];
      for (const p of c.children) {
        if (p.type === "(" || p.type === ")" || p.type === ",") continue;
        params.push(p.text.replace(/\s+/g, " ").trim());
      }
      for (let j = 0; j < params.length; j++) {
        result += paramIndent + params[j] + (j < params.length - 1 ? "," : "") + "\n";
      }
      result += indent + ")";
    } else if (c.type === "statement_block") {
      result += " " + format(c, 0, ind).trim();
    } else if (c.type === "type_annotation") {
      const typeText = c.children[1]?.text || c.text.slice(1).trim();
      result += ": " + typeText;
    } else {
      result += c.text + " ";
    }
  }

  return result.trim();
}

console.log(format(tree.rootNode));
