# The Intel shelf

A read-only shelf of links and notes that your bots, scripts or sessions
append to JSONL files. On the phone: newest first, search, type and tag
filters, each item's page with its link. Off until you turn it on at the
Mac.

```sh
jantar intel source add ~/bots/intel.jsonl
jantar intel on
```

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="img/intel-phone-dark.png"><img src="img/intel-phone.png" width="260" alt="The Intel shelf: saved links with type filters."></picture>
</p>

## Sources

A source is a `.jsonl` file on the Mac, given by its path and named by its
file name: `~/bots/intel.jsonl` shows as "intel" on the phone. Jantar reads it at
start and then follows it for appended lines. No path leaves the Mac.

- At most 10 sources, each at most 50 MB, and lines of at most 256 KB.
- Protected files are refused (the same denylist as Files: keys, `.env`
  files, `~/.ssh` and the like).
- A line that is too long, is not a JSON object or has no title is skipped
  and counted.
- The shelf keeps the newest 5,000 items across all sources; older ones
  are dropped and counted.

```sh
jantar intel sources                  # the files it follows, with counts and errors
jantar intel source add <file.jsonl>  # follow a file
jantar intel source rm <id>           # stop following one (the file is untouched)
jantar intel off                      # hide the shelf again
```

## Adding an item

From the Mac:

```sh
jantar intel add "A tool worth a look" --url https://example.com/tool --type tool --tag tools --note "what it is"
```

`--tag` can be given more than once. A link already on the shelf is not
added twice. The phone's Add sheet does the same. Both append one line to
Jantar's own captures file, `~/.jantar/intel/captures.jsonl`, which the
shelf follows like any other source. A capture from the Mac keeps the
folder it ran in, in that file only; the shelf never shows it.

```sh
jantar intel list --q prisma --type tool --tag tools --limit 50   # newest first; default 20, at most 100
```

## The line format

One JSON object per line. Jantar has no fixed schema: it maps common field
names, the first one that gives a usable value winning, and shows every
other plain field as a label and a value.

| Shown as | Field names, in order | Notes |
|---|---|---|
| title | `title`, `name`, `headline` | required: a line without one is skipped; at most 300 characters |
| link | `url`, `link` | http and https only; anything else is dropped |
| time | `captured_at`, `created_at`, `at`, `ts`, `date` | ISO text, or epoch seconds or milliseconds; items with no time sort last |
| type | `type`, `kind` | at most 40 characters; the type filter |
| tags | `tags` | an array of strings, at most 20 |
| "What it is" | `what_it_is`, `summary`, `description`, `text` | at most 2,000 characters |
| "Why it matters" | `why_it_matters`, `why` | at most 2,000 characters |
| id | `id` | printable, at most 128 characters; without one, a hash of the source, link and title. A later line with the same id replaces the earlier one |
| fields | everything else | strings, numbers, booleans and arrays of strings, in file order, at most 20; objects are skipped. A value that is one whole http(s) address shows as a link |

For example:

```json
{"id":"t-104","title":"A tool worth a look","url":"https://example.com/tool","type":"tool","tags":["cli","search"],"what_it_is":"A fast file finder.","why_it_matters":"Replaces two scripts.","captured_at":"2026-10-30T09:12:00Z","stars":1200}
```

Search looks at the title, "what it is", "why it matters", tags and field
values, without case.
