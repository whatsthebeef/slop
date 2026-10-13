import type { BoardService } from '@slop/core';
import type { Hono } from 'hono';
import { crc32 } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from './app.js';
import { errorBody, statusOf } from './views.js';

const SKILL = 'slop-attach';

interface Entry {
  readonly name: string;
  readonly data: Buffer;
  readonly mode: number;
}

const walk = (root: string, dir = ''): Entry[] =>
  readdirSync(join(root, dir)).flatMap((f) => {
    const rel = dir === '' ? f : `${dir}/${f}`;
    const stat = statSync(join(root, rel));
    return stat.isDirectory() ? walk(root, rel) : [{ name: rel, data: readFileSync(join(root, rel)), mode: stat.mode & 0o777 }];
  });

// 1980-01-01 00:00, so the same files always make the same zip.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/** A zip (stored, no compression) of `<skillsDir>/<skill>`, with the skill's folder as the top level and file modes kept. */
export const buildSkillZip = (skillsDir: string, skill = SKILL): Buffer => {
  const entries = walk(join(skillsDir, skill)).sort((a, b) => (a.name < b.name ? -1 : 1));
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(`${skill}/${e.name}`);
    const crc = crc32(e.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(e.data.length, 18);
    head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, e.data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode is read
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(e.data.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + e.data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
};

export interface SkillZipDeps {
  readonly boards: Pick<BoardService, 'get'>;
  /** The folder holding `slop-attach/` (the repo's `skills/`; copied into the image). */
  readonly skillsDir: string;
  /** The host the uploads go to (the bucket's), for the install steps; null when file attachments are off. */
  readonly uploadHost: string | null;
}

/** The slop-attach Claude app skill as a zip, with its install steps. Board members only; the skill itself holds no secrets. */
export const mountSkillZip = (app: Hono<Env>, deps: SkillZipDeps): void => {
  let zip: Buffer | null = null;
  const member = async (email: string, board: number) => {
    const found = await deps.boards.get(email, board);
    return found.ok ? null : found.error;
  };

  app.get(`/api/boards/:b/skills/${SKILL}.zip`, async (c) => {
    const denied = await member(c.get('email'), Number(c.req.param('b')));
    if (denied !== null) return c.json(errorBody(denied), statusOf(denied));
    zip ??= buildSkillZip(deps.skillsDir);
    return c.body(new Uint8Array(zip), 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${SKILL}.zip"`,
    });
  });

  app.get(`/api/boards/:b/skills/${SKILL}`, async (c) => {
    const board = Number(c.req.param('b'));
    const denied = await member(c.get('email'), board);
    if (denied !== null) return c.json(errorBody(denied), statusOf(denied));
    return c.json({
      name: SKILL,
      zipUrl: `/api/boards/${String(board)}/skills/${SKILL}.zip`,
      uploadHost: deps.uploadHost,
      install: [
        `Download ${SKILL}.zip.`,
        'In the Claude app: Settings > Capabilities > Skills > Upload skill, and choose the zip.',
        ...(deps.uploadHost === null
          ? []
          : [`In Settings > Capabilities > Code execution, add ${deps.uploadHost} to the allowed network domains, so the skill's script can reach the upload bucket.`]),
      ],
    });
  });
};
