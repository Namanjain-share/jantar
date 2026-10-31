/**
 * Prism in the highlight worker (workers/highlight.worker.ts): core plus
 * the grammars in LANGUAGES (the daemon's language ids, files/kinds.ts),
 * loaded in dependency order. Import order here is load order, and it
 * matters: settings, then core, then each component after what it needs.
 *
 * Only the worker imports this. The page never runs Prism, so a slow or
 * hostile grammar match can only stall the worker, which the page
 * terminates after HIGHLIGHT_WATCHDOG_MS.
 *
 * Tokenizing runs Prism's before- and after-tokenize hooks, as
 * Prism.highlight does (minus the HTML): PHP needs them, since
 * markup-templating cuts the `<?php ... ?>` blocks out, reads the rest as
 * HTML, and puts the blocks back as PHP tokens.
 */
import './prism-env.js';
import Prism from './prism-global.js';
import 'prismjs/components/prism-markup.js';
import 'prismjs/components/prism-css.js';
import 'prismjs/components/prism-clike.js';
import 'prismjs/components/prism-javascript.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-markdown.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-toml.js';
import 'prismjs/components/prism-ruby.js';
import 'prismjs/components/prism-java.js';
import 'prismjs/components/prism-c.js';
import 'prismjs/components/prism-cpp.js';
import 'prismjs/components/prism-swift.js';
import 'prismjs/components/prism-kotlin.js';
import 'prismjs/components/prism-docker.js';
import 'prismjs/components/prism-ini.js';
import 'prismjs/components/prism-scss.js';
import 'prismjs/components/prism-diff.js';
import 'prismjs/components/prism-lua.js';
import 'prismjs/components/prism-makefile.js';
import 'prismjs/components/prism-csharp.js';
import 'prismjs/components/prism-markup-templating.js';
import 'prismjs/components/prism-php.js';
import 'prismjs/components/prism-clojure.js';
import 'prismjs/components/prism-dart.js';
import 'prismjs/components/prism-elixir.js';
import 'prismjs/components/prism-erlang.js';
import 'prismjs/components/prism-graphql.js';
import 'prismjs/components/prism-groovy.js';
import 'prismjs/components/prism-haskell.js';
import 'prismjs/components/prism-hcl.js';
import 'prismjs/components/prism-latex.js';
import 'prismjs/components/prism-less.js';
import 'prismjs/components/prism-objectivec.js';
import 'prismjs/components/prism-ocaml.js';
import 'prismjs/components/prism-perl.js';
import 'prismjs/components/prism-powershell.js';
import 'prismjs/components/prism-properties.js';
import 'prismjs/components/prism-protobuf.js';
import 'prismjs/components/prism-r.js';
import 'prismjs/components/prism-sass.js';
import 'prismjs/components/prism-scala.js';
import 'prismjs/components/prism-ignore.js';
import { LANGUAGES, type LanguageId } from './languages.js';
import { toLines, type PrismStream } from './tokens.js';
import { withinLimits, type Line } from './types.js';

const KNOWN = new Set<string>(LANGUAGES);

/** The grammar for one of LANGUAGES (an own property only: `lang` came over a message). */
export function grammarFor(lang: string): object | null {
  if (!KNOWN.has(lang) || !Object.prototype.hasOwnProperty.call(Prism.languages, lang)) return null;
  return Prism.languages[lang as LanguageId] ?? null;
}

/** What Prism's tokenize hooks read and change (Prism.highlight's `env`, without the HTML). */
interface TokenizeEnv {
  code: string;
  grammar: object;
  language: string;
  tokens?: PrismStream;
}

/** Highlighted lines, or null when the grammar is unknown or the text is over the limits. */
export function highlightLines(text: string, lang: string): Line[] | null {
  const grammar = grammarFor(lang);
  if (!grammar || !withinLimits(text)) return null;
  const env: TokenizeEnv = { code: text, grammar, language: lang };
  Prism.hooks.run('before-tokenize', env);
  env.tokens = Prism.tokenize(env.code, env.grammar) as PrismStream;
  Prism.hooks.run('after-tokenize', env);
  return toLines(env.tokens);
}
