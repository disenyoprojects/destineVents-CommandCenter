// Back up — and if needed restore — every file in the receipts bucket.
//
// Why this exists (handover §15C): Supabase's database backups cover the
// tables, not the files in Storage. A receipt deleted by mistake, or lost in a
// project move, would be gone for good. This copies every file to a folder on
// your computer, along with the list of which file belongs to which record.
//
// BACK UP (do this monthly, and before any storage change):
//   node --env-file=.env.local scripts/backup-receipts.mjs
//   → writes ~/HQ-receipts-backup/<today>/ with every file, plus
//     finance_attachments.json (which record each file belongs to) and
//     manifest.json (every file and its size). Copy that folder somewhere safe,
//     e.g. the company Google Drive.
//
// RESTORE (after a loss — puts back only files that are missing; never
// overwrites anything already in storage):
//   node --env-file=.env.local scripts/backup-receipts.mjs --restore ~/HQ-receipts-backup/2026-11-24
//   then run database/ops/check-receipt-files.sql to confirm nothing is missing.
//
// Needs VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local. The
// service-role key bypasses all access rules — keep it on this computer only,
// never commit it, never paste it anywhere else.
import { createClient } from '@supabase/supabase-js';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const BUCKET = 'receipts';
const PAGE = 1000;

function client() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example).');
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// Storage lists one folder at a time; folders come back as entries with no id.
async function listAll(sb, prefix = '') {
  const files = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb.storage.from(BUCKET).list(prefix, { limit: PAGE, offset });
    if (error) throw new Error(`Could not list "${prefix || '/'}": ${error.message}`);
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) files.push(...await listAll(sb, path));
      else files.push({ path, size: entry.metadata?.size ?? null, mimetype: entry.metadata?.mimetype ?? null });
    }
    if (data.length < PAGE) return files;
  }
}

async function backup(sb) {
  const today = new Date().toISOString().slice(0, 10);
  const outDir = join(homedir(), 'HQ-receipts-backup', today);
  const files = await listAll(sb);
  console.info(`Backing up ${files.length} file(s) to ${outDir}`);

  const failed = [];
  for (const file of files) {
    const target = join(outDir, file.path);
    const existing = await stat(target).catch(() => null);
    if (existing && existing.size === file.size) continue;
    const { data, error } = await sb.storage.from(BUCKET).download(file.path);
    if (error) { failed.push(file.path); continue; }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await data.arrayBuffer()));
  }

  const { data: rows, error } = await sb.from('finance_attachments').select('*').order('id');
  if (error) console.warn(`finance_attachments not saved (${error.message}) — has migration 022 been run?`);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'finance_attachments.json'), JSON.stringify(rows ?? [], null, 2));
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ bucket: BUCKET, takenAt: new Date().toISOString(), files }, null, 2));

  console.info(`Done: ${files.length - failed.length} saved, ${failed.length} failed.`);
  if (failed.length) { console.error('Failed:', failed.join(', ')); process.exitCode = 1; }
}

const MIME_BY_EXTENSION = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

// The type a file was stored with, or one worked out from its extension. It
// has to be sent explicitly: from Node, a file would otherwise go up as plain
// text, which the bucket refuses since migration 022.
function contentTypeFor(file) {
  const ext = file.path.split('.').pop()?.toLowerCase() ?? '';
  return file.mimetype || MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

// Restores only what the backup's manifest lists, so nothing else that ended
// up in the folder (.DS_Store and the like) is sent to storage.
async function restore(sb, fromDir) {
  const manifest = JSON.parse(await readFile(join(fromDir, 'manifest.json'), 'utf8'));
  const inStorage = new Set((await listAll(sb)).map(f => f.path));
  const missing = manifest.files.filter(f => !inStorage.has(f.path));
  console.info(`${missing.length} of ${manifest.files.length} backed-up file(s) are missing from storage — restoring those.`);

  let restored = 0;
  for (const file of missing) {
    const local = join(fromDir, file.path);
    const data = await readFile(local).catch(() => null);
    if (!data) { console.error(`Not in this backup folder: ${file.path}`); continue; }
    const contentType = contentTypeFor(file);
    const { error } = await sb.storage.from(BUCKET).upload(file.path, data, { upsert: false, contentType });
    if (!error) { restored++; continue; }
    const refusedType = /mime|type/i.test(error.message);
    console.error(refusedType
      ? `Could not restore ${file.path}: the bucket no longer accepts ${contentType} files (only PDF, JPG, PNG). Keep it from the backup folder by hand.`
      : `Could not restore ${file.path}: ${error.message}`);
  }
  console.info(`Done: ${restored} restored. Now run database/ops/check-receipt-files.sql.`);
  if (restored < missing.length) process.exitCode = 1;
}

const args = process.argv.slice(2);
const restoreAt = args.indexOf('--restore');
try {
  const sb = client();
  if (restoreAt >= 0) {
    const dir = args[restoreAt + 1];
    if (!dir) throw new Error('Give the backup folder after --restore');
    await restore(sb, dir.replace(/^~(?=$|\/)/, homedir()));
  } else {
    await backup(sb);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
