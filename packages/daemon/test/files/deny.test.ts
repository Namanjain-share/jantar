/**
 * The hard denylist (v0.3 spec 4.4.3, security rule F2): every entry,
 * any letter case, NFC and NFD names, the $HOME prefixes, home mode with
 * `folders.allow`, the system prefixes, `extraDeny`, and names that are
 * Object.prototype keys.
 */
import { describe, expect, it } from 'vitest';
import { DenyRules, deniedName, holdsPrivateKey, looksSecret, normSeg } from '../../src/files/deny.js';
import { AWS_LIKE, KEY_BEGIN, KEY_END } from './fp-helpers.js';

const HOME = '/Users/me';
const rules = (over: { extraDeny?: string[]; allow?: string[]; homes?: string[]; stateDirs?: string[] } = {}) =>
  new DenyRules({
    homes: over.homes ?? [HOME],
    stateDirs: over.stateDirs ?? [`${HOME}/.jantar`],
    extraDeny: over.extraDeny ?? [],
    allow: over.allow ?? [],
  });

const P = `${HOME}/work/proj`;

describe('hard denylist: names', () => {
  const r = rules();

  it.each(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', '.git', '.terraform.d'])(
    'refuses anything under a %s dir, wherever it is',
    (dir) => {
      expect(r.check(`${P}/${dir}`)).toBe('protected');
      expect(r.check(`${P}/deep/er/${dir}/config`)).toBe('protected');
    },
  );

  it.each([
    '.env',
    '.env.local',
    '.env.example',
    '.env.production.local',
    '.envrc',
    'server.pem',
    'tls.key',
    'AuthKey_ABC.p8',
    'cert.p12',
    'cert.pfx',
    'release.keystore',
    'debug.jks',
    'putty.ppk',
    'vault.kdbx',
    'id_rsa',
    'id_rsa.pub',
    'id_dsa',
    'id_ecdsa_sk',
    'id_ed25519.pub',
    'id_rsa_test.go',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.git-credentials',
    '.pgpass',
    '.my.cnf',
    '.htpasswd',
    '.vault-token',
    'login.keychain',
    'login.keychain-db',
    'credentials',
    'credentials.json',
    'client_secret.json',
    'client_secret_1234.apps.json',
    'service-account.json',
    'service-account-prod.json',
    '.env-local',
    '.env_prod',
    'prod.env',
    'docker.env',
    '.dev.vars',
    '.dev.vars.staging',
    'terraform.tfstate',
    'terraform.tfstate.backup',
    'prod.tfvars',
    'prod.auto.tfvars.json',
    '.yarnrc.yml',
    '.mcp.json',
    'kubeconfig',
    'credentials.toml',
    'credentials.yaml',
    '.s3cfg',
    'token.json',
    '.secrets',
    'secrets.yaml',
    'secrets.json',
    'serviceAccountKey.json',
    'myapp-firebase-adminsdk-x1y2z-0123456789.json',
    'firebase-adminsdk.json',
  ])('refuses the file name %s', (name) => {
    expect(deniedName(normSeg(name))).toBe(true);
    expect(r.check(`${P}/${name}`)).toBe('protected');
  });

  it('F2: refuses denylisted names in any case', () => {
    for (const rel of ['.ENV', '.Env.Local', '.env.example', 'ID_RSA.pub', 'server.PEM', 'client_secret_x.json', '.npmrc', '.git/config', '.GIT/HEAD', 'Credentials.JSON']) {
      expect(r.check(`${P}/${rel}`), rel).toBe('protected');
    }
  });

  it('a dir named like a secret is hidden with everything in it', () => {
    expect(r.check(`${P}/keys.pem/readme.txt`)).toBe('protected');
    expect(r.check(`${P}/.env/bin/python`)).toBe('protected');
  });

  it('leaves look-alikes alone', () => {
    for (const name of ['.gitignore', '.github/workflows/ci.yml', '.gitattributes', 'environment.ts', 'env.ts', '.envoy', '.venv/bin/activate', 'dotenv.ts', 'keys.ts', 'monkey.ts', 'my.key.ts', 'credential.ts', 'credentials.ts', 'secrets.md', 'tokens.ts', 'main.tf', 'variables.tf', '.yarnrc', 'mcp.ts', 'id.ts', 'README.md', 'package.json', '.prettierrc']) {
      expect(r.check(`${P}/${name}`), name).toBe('ok');
    }
  });

  it('project-level .claude folders stay readable; only ~/.claude* is protected', () => {
    expect(r.check(`${P}/.claude/commands/review.md`)).toBe('ok');
    expect(r.check(`${P}/.claude/settings.json`)).toBe('ok');
    expect(r.check(`${HOME}/.claude/settings.json`)).toBe('protected');
  });

  it('names that are Object.prototype keys are plain names', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '__proto__.md']) {
      expect(() => r.check(`${P}/${name}`)).not.toThrow();
      expect(r.check(`${P}/${name}`), name).toBe('ok');
    }
  });

  it('a relative path is always protected (nothing should ask with one)', () => {
    expect(r.check('work/proj/a.ts')).toBe('protected');
    expect(r.isProtected('')).toBe(true);
  });
});

describe('hard denylist: under $HOME', () => {
  const r = rules();

  it.each([
    'Library',
    'Library/Keychains/login.keychain-db',
    'Library/Mobile Documents/x.txt',
    'LIBRARY/Cookies/Cookies.binarycookies',
    '.claude',
    '.claude/settings.json',
    '.claude.json',
    '.claude.json.backup',
    '.claude-swap-backup/sessions/2-x/.claude.json',
    '.example-tool/adopt.py',
    '.config/ccw/telegram.json',
    '.jantar/cf-token',
    '.ccw-v2/push/vapid.json',
    '.ccw-v2/ccw-v2.db',
    '.config/gh/hosts.yml',
    '.config/gcloud/application_default_credentials.json',
    '.config/op/config',
    '.zsh_history',
    '.bash_history',
    '.python_history',
    '.node_repl_history',
    '.psql_history',
    '.mysql_history',
  ])('refuses ~/%s', (rel) => {
    expect(r.check(`${HOME}/${rel}`)).toBe('protected');
  });

  it('protects the state dir wherever $JANTAR_HOME puts it', () => {
    const elsewhere = rules({ stateDirs: ['/opt/ccw-state'] });
    expect(elsewhere.check('/opt/ccw-state/jantar.db')).toBe('protected');
    expect(elsewhere.check('/opt/other/file.txt')).toBe('ok');
  });

  it('matches $HOME given as itself or as its realpath', () => {
    const two = rules({ homes: ['/var/homes/me', '/private/var/homes/me'] });
    expect(two.check('/private/var/homes/me/.ssh/config')).toBe('protected');
    expect(two.check('/var/homes/me/Library/x')).toBe('protected');
    // Under $HOME the system prefixes do not apply...
    expect(two.check('/private/var/homes/me/work/a.ts')).toBe('ok');
    // ...elsewhere they do.
    expect(two.check('/private/var/other/a.ts')).toBe('protected');
  });

  it('$HOME itself and its plain entries are fine', () => {
    expect(r.check(HOME)).toBe('ok');
    expect(r.check(`${HOME}/notes.md`)).toBe('ok');
    expect(r.check(`${HOME}/Desktop/work/a.ts`)).toBe('ok');
  });
});

describe('home mode: every top-level dot entry of $HOME', () => {
  it('is protected, with or without a hard rule for it', () => {
    const r = rules();
    for (const rel of ['.config', '.config/nvim/init.lua', '.zshrc', '.local/share/x', '.dotfiles/vimrc', '.cache']) {
      expect(r.check(`${HOME}/${rel}`), rel).toBe('protected');
    }
  });

  it('folders.allow opens only the named path; its parents are only a way to it', () => {
    const r = rules({ allow: ['~/.config/nvim'] });
    expect(r.check(`${HOME}/.config/nvim`)).toBe('ok');
    expect(r.check(`${HOME}/.config/nvim/lua/plugins.lua`)).toBe('ok');
    expect(r.check(`${HOME}/.config`)).toBe('ancestor');
    expect(r.isProtected(`${HOME}/.config`)).toBe(true);
    expect(r.check(`${HOME}/.config/other/token`)).toBe('protected');
    expect(r.check(`${HOME}/.config/nvim-other`)).toBe('protected');
  });

  it('an allow entry never opens a hard rule', () => {
    const r = rules({ allow: ['~/.config', '~/.ssh', '~/.claude', `${HOME}/.zsh_history`, '~/.jantar'] });
    expect(r.check(`${HOME}/.config/nvim/init.lua`)).toBe('ok');
    expect(r.check(`${HOME}/.config/gh/hosts.yml`)).toBe('protected');
    expect(r.check(`${HOME}/.config/ccw/telegram.json`)).toBe('protected');
    expect(r.check(`${HOME}/.ssh/config`)).toBe('protected');
    expect(r.check(`${HOME}/.claude/settings.json`)).toBe('protected');
    expect(r.check(`${HOME}/.zsh_history`)).toBe('protected');
    expect(r.check(`${HOME}/.jantar/state`)).toBe('protected');
    expect(r.check(`${HOME}/.config/app/.env`)).toBe('protected');
  });

  it('allow entries outside $HOME or relative are ignored', () => {
    const r = rules({ allow: ['/etc', 'relative/.config', '.config'] });
    expect(r.check('/etc/hosts')).toBe('protected');
    expect(r.check(`${HOME}/.config/x`)).toBe('protected');
  });
});

describe('system prefixes', () => {
  it.each(['/etc/passwd', '/private/etc/hosts', '/private/tmp/x', '/var/log/system.log', '/System/Library/x', '/Library/Keychains/System.keychain', '/Volumes/USB/x.txt'])(
    'refuses %s',
    (p) => {
      expect(rules().check(p)).toBe('protected');
    },
  );

  it('other absolute paths are judged by name only', () => {
    expect(rules().check('/opt/src/app/main.go')).toBe('ok');
    expect(rules().check('/opt/src/app/.env')).toBe('protected');
  });

  it('a $HOME of "/" or one segment deep does not lift them', () => {
    for (const home of ['/', '/var', '/private']) {
      const r = rules({ homes: [home], stateDirs: ['/nowhere/.jantar'] });
      for (const p of ['/etc', '/etc/passwd', '/private/etc/hosts', '/var/db/x', '/Library/Keychains/System.keychain']) {
        expect(r.check(p), `${home}: ${p}`).toBe('protected');
      }
    }
    // A real home below a system prefix still does (a test home under /private/var).
    const deep = rules({ homes: ['/private/var/folders/xy/home'], stateDirs: ['/nowhere/.jantar'] });
    expect(deep.check('/private/var/folders/xy/home/work/a.ts')).toBe('ok');
    expect(deep.check('/private/var/folders/xy/home/.ssh/config')).toBe('protected');
    expect(deep.check('/private/var/folders/xy/other/a.ts')).toBe('protected');
  });
});

describe('extraDeny adds, never removes', () => {
  it('names (with *), segment runs, absolute and ~ paths', () => {
    const r = rules({ extraDeny: ['*.sqlite', 'secrets.yaml', 'config/prod.yml', '/opt/vault', '~/private-notes'] });
    expect(r.check(`${P}/data/app.SQLITE`)).toBe('protected');
    expect(r.check(`${P}/k8s/secrets.yaml`)).toBe('protected');
    expect(r.check(`${P}/config/prod.yml`)).toBe('protected');
    expect(r.check(`${P}/config/dev.yml`)).toBe('ok');
    expect(r.check('/opt/vault/x')).toBe('protected');
    expect(r.check(`${HOME}/private-notes/a.md`)).toBe('protected');
    expect(r.check(`${HOME}/public-notes/a.md`)).toBe('ok');
    // Regex characters in a name are literal.
    expect(rules({ extraDeny: ['a+b(1).txt'] }).check(`${P}/a+b(1).txt`)).toBe('protected');
    expect(rules({ extraDeny: ['a+b(1).txt'] }).check(`${P}/aab1.txt`)).toBe('ok');
  });

  it('an empty or blank extraDeny entry adds nothing and removes nothing', () => {
    const r = rules({ extraDeny: ['', '   ', '*'.repeat(0)] });
    expect(r.check(`${P}/a.ts`)).toBe('ok');
    expect(r.check(`${P}/.env`)).toBe('protected');
  });
});

describe('NFC and NFD', () => {
  const nfc = 'caf\u00e9';
  const nfd = 'cafe\u0301';

  it('an NFC extraDeny name matches an NFD file name and the other way round', () => {
    expect(nfc).not.toBe(nfd);
    expect(rules({ extraDeny: [`${nfc}-keys.txt`] }).check(`${P}/${nfd}-keys.txt`)).toBe('protected');
    expect(rules({ extraDeny: [`${nfd}-keys.txt`] }).check(`${P}/${nfc}-keys.txt`)).toBe('protected');
    expect(rules({ extraDeny: [`~/${nfc}`] }).check(`${HOME}/${nfd}/a.txt`)).toBe('protected');
  });

  it('allow and $HOME match in either form', () => {
    expect(rules({ allow: [`~/.config/${nfd}`] }).check(`${HOME}/.config/${nfc}/x`)).toBe('ok');
    const home = `/Users/${nfc}`;
    expect(rules({ homes: [home] }).check(`/Users/${nfd}/.ssh/config`)).toBe('protected');
    expect(rules({ homes: [home] }).check(`/Users/${nfd}/Library/x`)).toBe('protected');
  });

  it('case folding is Unicode lower-casing: a dotted capital I is not an ASCII I (APFS sees another file too)', () => {
    // "\u0130" (capital I with dot) lower-cases to "i" + U+0307: not "id_rsa", so not a key...
    expect(rules().check(`${P}/\u0130D_RSA`)).toBe('ok');
    // ...while every ASCII spelling is.
    expect(rules().check(`${P}/Id_Rsa`)).toBe('protected');
  });

  it('letters APFS folds that lower-casing alone leaves: a long s, a Kelvin sign, fullwidth forms', () => {
    // APFS opens "id_r\u017fa" as the real "id_rsa"; the lexical check must see it too.
    expect(normSeg('id_r\u017fa')).toBe('id_rsa');
    expect(rules().check(`${P}/keys/id_r\u017fa`)).toBe('protected');
    expect(rules().check(`${P}/.\u017f\u017fh/config`)).toBe('protected');
    expect(rules().check(`${P}/server.\u212aEY`)).toBe('protected');
    expect(rules().check(`${P}/.\uff47\uff49\uff54/config`)).toBe('protected');
    expect(rules().check(`${P}/\uff0eenv`)).toBe('protected');
    expect(rules({ extraDeny: ['secret\u017f.txt'] }).check(`${P}/SECRETS.txt`)).toBe('protected');
    // Plain names are untouched.
    expect(rules().check(`${P}/src/main.ts`)).toBe('ok');
  });
});

describe('content rules', () => {
  it('a private key block, BEGIN or END, in any key flavour', () => {
    expect(holdsPrivateKey(`x\n${KEY_BEGIN}\nAAAA\n`)).toBe(true);
    expect(holdsPrivateKey(`AAAA\n${KEY_END}\n`)).toBe(true);
    expect(holdsPrivateKey('-----' + 'BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(holdsPrivateKey('-----' + 'BEGIN EC PRIVATE KEY-----')).toBe(true);
    expect(holdsPrivateKey('-----' + 'BEGIN PRIVATE KEY-----')).toBe(true);
    expect(holdsPrivateKey('-----' + 'BEGIN PGP PRIVATE KEY BLOCK-----')).toBe(true);
    expect(holdsPrivateKey('-----' + 'BEGIN PUBLIC KEY-----')).toBe(false);
    expect(holdsPrivateKey('-----' + 'BEGIN CERTIFICATE-----')).toBe(false);
  });

  it('secret-looking tokens are only flagged', () => {
    expect(looksSecret(`key = "${AWS_LIKE}"`)).toBe(true);
    expect(looksSecret('token ghp_' + 'a'.repeat(36))).toBe(true);
    expect(looksSecret('github' + '_pat_11ABC')).toBe(true);
    expect(looksSecret('sk-' + 'ant-api03-x')).toBe(true);
    expect(looksSecret('xo' + 'xb-123')).toBe(true);
    expect(looksSecret('xo' + 'xp-123')).toBe(true);
    expect(looksSecret('nothing to see')).toBe(false);
  });
});
