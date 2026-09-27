# Query language

One `key:value` language for every place a user narrows something down: the
search box and series filters today. Terms read the same wherever they are
typed, e.g.

```
level:error service:api,worker latency:>=250 message:*timeout*
```

Each surface parses it into its own predicates and supports a subset of the
terms below:

| Feature | Search (`src/search/query.ts`) | Series filter (`src/series/filter.ts`) |
| --- | --- | --- |
| `key:v`, `key:"quoted v"` | ✓ | ✓ |
| `key:*` (has the key) | ✓ | ✓ |
| Free text between terms | ✓ — the full-text part | ✗ — refused |
| `-key:v`, `key:a,b`, `key:>v` `>=` `<` `<=`, `key:*text*` | ✗ — not yet | ✓ |
| Keys | document properties; `type`, `modified` are aliases | point fields; `type`, `ts` are columns |
| Unparseable input | kept as full text | refused with `400` |

A new surface takes this language rather than inventing another; a term it
cannot honour is refused, never ignored.

## Series filters

The server parses a series filter into the same predicates the JSON `where`
form carries, so a filter selects exactly what the equivalent `where` would —
on range reads, on queries, and on the live event bus.

| Endpoint | Field |
| --- | --- |
| `GET …/series/[name]/points` | `filter` query parameter |
| `POST …/series/[name]/query` | `filter` body field (string) |

Both also take `where` (a predicate array). When both are given, every term
of both must match.

## Grammar

```ebnf
filter     = [ ws ] , [ term , { ws , term } ] , [ ws ] ;
term       = [ "-" ] , key , ":" , ( comparison | exists | contains | values ) ;
key        = ( letter | "_" ) , { letter | digit | "_" | "." | "-" } ;
comparison = ( ">=" | "<=" | ">" | "<" ) , value ;
exists     = "*" ;
contains   = "*" , ( quoted | bare ) , "*" ;
values     = value , { "," , value } ;
value      = quoted | bare ;
quoted     = '"' , { any character except '"' } , '"' ;
bare       = char , { char } ;            (* no whitespace, '"' or ',' *)
ws         = whitespace , { whitespace } ;
```

This is the full language; see the table above for what each surface accepts.
Terms are separated by whitespace outside quotes. There is no `OR`, no
grouping and no escape character: a double quote cannot appear inside a value.

## Terms

| Term | Predicate | Matches a point whose `key` … |
| --- | --- | --- |
| `key:v` | `eq` | equals `v` |
| `-key:v` | `ne` | is present and not `v` |
| `key:a,b,c` | `in` | equals any of the values |
| `key:>v` `key:>=v` `key:<v` `key:<=v` | `gt` `gte` `lt` `lte` | compares against `v` |
| `key:*text*` | `contains` | is a string containing `text` |
| `key:*"two words"*` | `contains` | is a string containing `two words` |
| `key:*` | `exists` | is present |

## Values

- **Numbers.** A bare value that looks like a number (`-?\d+(\.\d+)?`) is a
  number: `speed:>30`, `code:404`. Quote it to compare as a string:
  `zip:"01234"`.
- **Strings.** Anything else is a string. Quote values holding spaces or
  commas: `service:"api gateway"`, `city:"Berlin, DE"`.
- **Types must match.** `code:404` does not match a point whose `code` is the
  string `"404"`. Strings order lexically, numbers numerically, and a
  comparison between the two never matches.
- **Booleans** have no literal; filter them with `where`.

## Keys in series filters

Any field name, plus the two built-in columns:

- `type` — the point's type, e.g. `type:workflow.log`.
- `ts` — event time in ms since the epoch, e.g. `ts:>=1764547200000`. For time
  ranges, prefer the request's `from`/`to`: they also bound what is read.

A key the point does not carry fails every term, `-key:v` included: negation
means "present and different", not "anything but".

## Errors in series filters

A filter that does not parse is refused whole with `400` and a message naming
the term. These are errors rather than silently ignored:

| Input | Why |
| --- | --- |
| `level` | not `key:value` |
| `level:` | no value |
| `service:"api` | unbalanced quote |
| `speed:>1,2`, `-speed:>1` | a comparison takes exactly one value and cannot be negated |
| `-host:a,b` | a list cannot be negated |
| `-id:*`, `-message:*x*` | `exists` and `contains` cannot be negated |

## Series filter examples

| Filter | Reads as |
| --- | --- |
| `level:error` | errors |
| `level:warn,error -service:web` | warnings and errors, except from `web` |
| `speed:>=80 ignition:*` | fast points that report ignition |
| `usage:>90 host:node-0` | hot samples on one host |
| `message:*"connection reset"*` | log lines mentioning a reset |
| `type:workflow.log level:error` | workflow run errors |

## Equivalent `where`

`level:warn,error -service:web latency:>=250` is exactly

```json
[
  { "column": "level", "op": "in", "value": ["warn", "error"] },
  { "column": "service", "op": "ne", "value": "web" },
  { "column": "latency", "op": "gte", "value": 250 }
]
```
