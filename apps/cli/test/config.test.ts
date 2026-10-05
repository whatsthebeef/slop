import { describe, expect, it } from 'vitest';
import {
  insecureUrlWarning,
  loadSettings,
  parseConfigFile,
  repoConfigPath,
  requireSetting,
  userConfigPath,
} from '../src/config.js';
import { SlopError } from '../src/errors.js';

const USER = userConfigPath('/home/dev');
const REPO = repoConfigPath('/work/repo');

function sources(env: Record<string, string>, files: Record<string, string>) {
  return { env, files: [USER, REPO], readFile: (path: string) => files[path] };
}

describe('config', () => {
  it('reads the environment first, then the user config, then the repo config', () => {
    const settings = loadSettings(
      sources(
        { SLOP_URL: 'https://env.test' },
        {
          [USER]: 'SLOP_URL=https://user.test\nSLOP_CLIENT_ID=user-client\n',
          [REPO]:
            'SLOP_URL=https://repo.test\nSLOP_CLIENT_ID=repo-client\nSLOP_DEV_EMAIL=dev@x.test\n',
        },
      ),
    );
    expect(settings).toEqual({
      SLOP_URL: 'https://env.test',
      SLOP_CLIENT_ID: 'user-client',
      SLOP_DEV_EMAIL: 'dev@x.test',
    });
  });

  it('skips empty environment values and missing files', () => {
    const settings = loadSettings(
      sources({ SLOP_URL: '' }, { [REPO]: 'SLOP_URL=https://repo.test' }),
    );
    expect(settings).toEqual({ SLOP_URL: 'https://repo.test' });
  });

  it('parses KEY=VALUE lines, ignoring comments and stripping quotes', () => {
    expect(
      parseConfigFile(
        '# comment\n\n SLOP_URL = "https://a.test/" \nSLOP_CLIENT_ID=\'abc\'\nnoise\n',
      ),
    ).toEqual({ SLOP_URL: 'https://a.test/', SLOP_CLIENT_ID: 'abc' });
  });

  it('requires a setting and drops trailing slashes', () => {
    expect(requireSetting({ SLOP_URL: 'https://a.test//' }, 'SLOP_URL')).toBe('https://a.test');
    expect(() => requireSetting({}, 'SLOP_CLIENT_ID')).toThrow(SlopError);
  });

  it('warns about an http SLOP_URL on a non-loopback host only', () => {
    expect(insecureUrlWarning({ SLOP_URL: 'http://slop.example.com' })).toContain('not https');
    for (const url of [
      'https://slop.example.com',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
    ]) {
      expect(insecureUrlWarning({ SLOP_URL: url })).toBeUndefined();
    }
    expect(insecureUrlWarning({})).toBeUndefined();
  });
});
