#!/usr/bin/env node
// Admin commands for Julklappsleken. Run `node admin.mjs` for usage.

import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ITERATIONS, normalizeMaster, openVault, randomBase64, sealEntry, sealVault } from './crypto.js';

const USAGE = `Usage: node admin.mjs <command> <year>

Commands:
  edit <year>                   Edit people, draw rules, budget and rules for a year
  draw <year> [--force]         Draw who gives to whom
  regen-password <year> <name>  Give someone a new password

When redrawing with draw --force, you can leave some people out:
  --keep "Anna,Erik"            They keep who they give to
  --fresh "Anna,Erik"           They get someone none of them has now

Every command asks for the master password, unless MASTER_PASSWORD is set
in .env (see .env.example). Commit and push data/ afterwards.
The editor comes from $VISUAL or $EDITOR. For VS Code use EDITOR="code --wait".`;

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const YEARS_PATH = join(DATA_DIR, 'years.json');

if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

// What `edit` lets you change. `drawRules` steer the draw; `budget` and `rules` are shown on everyone's page.
const EMPTY_CONFIG = {
  people: [],
  drawRules: { exclude: [], block: [], avoidPreviousYears: 0, noMutualPairs: false },
  budget: '',
  rules: [],
};

// Swedish Christmas words without å, ä and ö, so passwords are easy to type on any keyboard.
const WORDS = [
  'tomte', 'nisse', 'julgran', 'granris', 'kula', 'glitter', 'ljus', 'lykta',
  'lussekatt', 'pepparkaka', 'polkagris', 'marsipan', 'kola', 'julmust', 'kanel', 'saffran',
  'mandel', 'russin', 'apelsin', 'klementin', 'kardemumma', 'nejlika', 'mistel', 'kotte',
  'stearin', 'krans', 'frost', 'rimfrost', 'vinter', 'istapp', 'vante', 'halsduk',
  'strumpa', 'toffel', 'filt', 'brasa', 'kamin', 'julbock', 'halmbock', 'lucia',
  'julklapp', 'paket', 'rosett', 'ren', 'pulka', 'skridsko', 'skinka', 'sill',
  'prinskorv', 'advent', 'kalender', 'tindra', 'norrsken', 'pyssel', 'julkort', 'karamell',
  'choklad', 'nougat', 'kanelbulle', 'julafton', 'knut', 'staffan', 'isbana', 'midvinter',
];

// How many random shuffles `draw` tries before giving up.
const DRAW_ATTEMPTS = 1_000_000;

class AdminError extends Error {}

// Commands

async function edit(year) {
  const isNew = !readYear(year);
  const { file, master, vault } = isNew ? await startYear(year) : await unlock(year);
  const before = configOf(vault);
  const after = await editConfig(before, year);
  if (!isNew && JSON.stringify(after) === JSON.stringify(before)) {
    console.log('No changes.');
    return;
  }

  const oldNames = vault.people.map((person) => person.name);
  const added = after.people.filter((name) => !oldNames.includes(name));
  const removed = oldNames.filter((name) => !after.people.includes(name));
  if (vault.draw && (added.length || removed.length)) {
    const ok = await confirm('The names changed, so the draw will be cleared and you need to draw again. Continue?', false);
    if (!ok) throw new AdminError('Nothing saved.');
    vault.draw = null;
  } else if (vault.draw && JSON.stringify(after.drawRules) !== JSON.stringify(before.drawRules)) {
    console.log('Draw rules changed. The current draw is kept. Run draw --force to redraw with the new rules.');
  }

  const people = after.people.map((name) => vault.people.find((person) => person.name === name) ?? { name, password: null });
  Object.assign(vault, after, { people });
  await save(file, master, vault);

  if (added.length) console.log(`Added: ${added.join(', ')}`);
  if (removed.length) console.log(`Removed: ${removed.join(', ')}`);
  console.log(`Saved ${year} with ${vault.people.length} people. Commit and push data/ to publish.`);
}

async function draw(year, args) {
  const { file, master, vault } = await unlock(year);
  if (vault.draw && !args.includes('--force')) {
    throw new AdminError(`${year} is already drawn. Use --force to draw again.`);
  }
  const names = vault.people.map((person) => person.name);
  const minimum = vault.drawRules.noMutualPairs ? 3 : 2;
  if (names.length < minimum) throw new AdminError(`Need at least ${minimum} people to draw.`);

  const keep = peopleOption(args, '--keep', vault, year);
  const fresh = peopleOption(args, '--fresh', vault, year);
  if ((keep.length || fresh.length) && !vault.draw) {
    throw new AdminError(`${year} isn't drawn yet, so there's nothing to keep or change.`);
  }
  const both = keep.find((name) => fresh.includes(name));
  if (both) throw new AdminError(`${both} can't be in both --keep and --fresh.`);

  // --keep givers keep who they have. --fresh givers get someone none of them has now.
  const kept = Object.fromEntries(keep.map((giver) => [giver, vault.draw[giver]]));
  const avoid = fresh.flatMap((giver) => fresh.map((other) => [giver, vault.draw[other]]));

  const previous = await previousDraws(year, vault.drawRules.avoidPreviousYears, master);
  vault.draw = makeDraw(names, vault.drawRules, previous, kept, avoid);
  if (!vault.draw) {
    throw new AdminError(
      `No random draw fit the draw rules in ${DRAW_ATTEMPTS.toLocaleString('en')} tries. Nothing saved. Try fewer exclude/block pairs, a lower avoidPreviousYears or fewer --keep/--fresh names.`,
    );
  }
  await save(file, master, vault);
  const drew = keep.length ? `Kept ${keep.length} and redrew ${names.length - keep.length}` : `Drew ${names.length}`;
  console.log(`${drew} people for ${year}. Commit and push data/ to publish.`);
}

async function regenPassword(year, args) {
  const name = args.join(' ').trim();
  if (!name) throw new AdminError('Usage: node admin.mjs regen-password <year> <name>');
  const { file, master, vault } = await unlock(year);
  const person = findPerson(vault, name, year);
  person.password = newPassword(vault.people);
  await save(file, master, vault);
  console.log(`New password for ${person.name}: ${person.password}`);
  console.log('Commit and push data/ to publish.');
}

// Year files

async function unlock(year) {
  const file = readYear(year);
  if (!file) throw new AdminError(`There's no game for ${year} yet. Start one with: node admin.mjs edit ${year}`);
  const master = process.env.MASTER_PASSWORD || (await ask('Master password: ', { hidden: true }));
  const vault = await openVault(file, master);
  if (!vault) {
    throw new AdminError(process.env.MASTER_PASSWORD ? 'MASTER_PASSWORD in .env is wrong for this year.' : 'Wrong master password.');
  }
  return { file, master, vault };
}

// A new year starts from the latest earlier year's people and rules,
// if the master password opens it. Passwords are always new.
async function startYear(year) {
  const fromEnv = Boolean(process.env.MASTER_PASSWORD);
  const master = process.env.MASTER_PASSWORD || (await ask('Master password: ', { hidden: true }));
  if (!normalizeMaster(master)) throw new AdminError("The master password can't be empty.");

  const earlier = readYears().filter((y) => y < year).at(-1);
  const template = earlier ? await openVault(readYear(earlier), master) : null;
  if (template) {
    console.log(`Starting from ${earlier}'s people and rules.`);
  } else if (fromEnv) {
    if (earlier) console.log(`MASTER_PASSWORD doesn't open ${earlier}, so ${year} starts empty.`);
  } else {
    if (earlier) console.log(`That password doesn't open ${earlier}. To use it as a new master password, repeat it.`);
    const repeat = await ask('Repeat master password: ', { hidden: true });
    if (normalizeMaster(repeat) !== normalizeMaster(master)) throw new AdminError("The passwords don't match.");
  }

  const file = {
    version: 1,
    year,
    iterations: ITERATIONS,
    masterSalt: randomBase64(16),
    entrySalt: randomBase64(16),
    master: null,
    entries: {},
  };
  const config = template ? configOf(template) : structuredClone(EMPTY_CONFIG);
  const people = config.people.map((name) => ({ name, password: null }));
  return { file, master, vault: { ...config, people, draw: null } };
}

// Encrypts the vault with the master password and each person's entry with their own password.
async function save(file, master, vault) {
  for (const person of vault.people) person.password ??= newPassword(vault.people);

  file.master = await sealVault(file, master, vault);
  const sealed = await Promise.all(
    vault.people.map((person) =>
      sealEntry(file, person.password, {
        year: file.year,
        from: person.name,
        to: vault.draw?.[person.name] ?? null,
        budget: vault.budget,
        rules: vault.rules,
      }),
    ),
  );
  file.entries = Object.fromEntries(sealed.map(({ id, box }) => [id, box]).sort(([a], [b]) => a.localeCompare(b)));

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(yearPath(file.year), JSON.stringify(file, null, 2) + '\n');
  const years = readYears();
  if (!years.includes(file.year)) {
    writeFileSync(YEARS_PATH, JSON.stringify([...years, file.year].sort((a, b) => a - b)) + '\n');
  }
}

async function previousDraws(year, count, master) {
  const draws = [];
  for (let y = year - count; y < year; y++) {
    const file = readYear(y);
    if (!file) continue;
    let vault = await openVault(file, master);
    while (!vault) {
      const password = await ask(`Master password for ${y} (empty to skip that year): `, { hidden: true });
      if (!password) break;
      vault = await openVault(file, password);
      if (!vault) console.error('Wrong password.');
    }
    if (vault?.draw) draws.push(vault.draw);
  }
  return draws;
}

function findPerson(vault, name, year) {
  const person = vault.people.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!person) {
    throw new AdminError(`"${name}" isn't in ${year}. People: ${vault.people.map((p) => p.name).join(', ')}`);
  }
  return person;
}

// Reads the names after a flag, like --keep "Anna,Erik".
function peopleOption(args, flag, vault, year) {
  const index = args.indexOf(flag);
  if (index === -1) return [];
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new AdminError(`Give names after ${flag}, like ${flag} "Anna,Erik".`);
  return value.split(',').map((name) => findPerson(vault, name.trim(), year).name);
}

function yearPath(year) {
  return join(DATA_DIR, `${year}.json`);
}

function readYear(year) {
  const path = yearPath(year);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function readYears() {
  return existsSync(YEARS_PATH) ? JSON.parse(readFileSync(YEARS_PATH, 'utf8')).sort((a, b) => a - b) : [];
}

// Editing

function configOf(vault) {
  return {
    people: vault.people.map((person) => person.name),
    drawRules: vault.drawRules,
    budget: vault.budget,
    rules: vault.rules,
  };
}

// The plain-text copy lives in the OS temp folder, never in the repo, and is deleted afterwards.
async function editConfig(config, year) {
  const dir = mkdtempSync(join(tmpdir(), 'julklappsleken-'));
  const path = join(dir, `${year}.json`);
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    while (true) {
      const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
      const result = spawnSync(`${editor} "${path}"`, { shell: true, stdio: 'inherit' });
      if (result.status !== 0) throw new AdminError(`The editor (${editor}) exited with an error.`);
      try {
        return validateConfig(JSON.parse(readFileSync(path, 'utf8')));
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof AdminError)) throw error;
        console.error(`\n${error instanceof SyntaxError ? `The file isn't valid JSON: ${error.message}` : error.message}\n`);
        if (!(await confirm('Edit again?', true))) throw new AdminError('Nothing saved.');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function validateConfig(input) {
  const problems = [];
  const check = (ok, message) => {
    if (!ok) problems.push(message);
    return ok;
  };
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isText = (value) => typeof value === 'string' && value.trim() !== '';

  if (!isObject(input)) throw new AdminError('The file must be a JSON object.');
  for (const key of Object.keys(input)) check(key in EMPTY_CONFIG, `Unknown field "${key}".`);

  const people = [];
  if (check(Array.isArray(input.people), '"people" must be a list of names.')) {
    for (const name of input.people) {
      if (!check(isText(name), `Names must be non-empty text, got ${JSON.stringify(name)}.`)) continue;
      const trimmed = name.trim();
      const duplicate = people.some((other) => other.toLowerCase() === trimmed.toLowerCase());
      if (check(!duplicate, `"${trimmed}" is listed twice.`)) people.push(trimmed);
    }
  }

  const drawRules = { ...EMPTY_CONFIG.drawRules };
  if (check(input.drawRules === undefined || isObject(input.drawRules), '"drawRules" must be an object.')) {
    Object.assign(drawRules, input.drawRules);
  }
  for (const key of Object.keys(drawRules)) check(key in EMPTY_CONFIG.drawRules, `Unknown draw rule "${key}".`);
  for (const field of ['exclude', 'block']) {
    if (!check(Array.isArray(drawRules[field]), `"drawRules.${field}" must be a list of pairs, like [["Anna", "Erik"]].`)) {
      drawRules[field] = [];
      continue;
    }
    drawRules[field] = drawRules[field].map((pair) => (Array.isArray(pair) ? pair.map((n) => (typeof n === 'string' ? n.trim() : n)) : pair));
    for (const pair of drawRules[field]) {
      if (!check(Array.isArray(pair) && pair.length === 2 && pair[0] !== pair[1], `"drawRules.${field}" has an invalid pair: ${JSON.stringify(pair)}.`)) continue;
      for (const name of pair) check(people.includes(name), `"drawRules.${field}" mentions "${name}", who isn't in "people".`);
    }
  }
  check(Number.isInteger(drawRules.avoidPreviousYears) && drawRules.avoidPreviousYears >= 0, '"drawRules.avoidPreviousYears" must be a whole number, 0 or more.');
  check(typeof drawRules.noMutualPairs === 'boolean', '"drawRules.noMutualPairs" must be true or false.');

  const budget = input.budget ?? '';
  check(typeof budget === 'string', '"budget" must be text, like "500 kr".');

  const rules = input.rules ?? [];
  if (check(Array.isArray(rules), '"rules" must be a list of sentences.')) {
    for (const rule of rules) check(isText(rule), `Rules must be non-empty text, got ${JSON.stringify(rule)}.`);
  }

  if (problems.length) throw new AdminError(problems.join('\n'));
  return { people, drawRules, budget: budget.trim(), rules: rules.map((rule) => rule.trim()) };
}

// Drawing

// `kept` maps givers to receivers that stay as they are. `avoid` holds extra [giver, receiver] pairs to ban.
function makeDraw(names, drawRules, previousDraws, kept = {}, avoid = []) {
  const banned = new Set();
  const ban = (giver, receiver) => banned.add(`${giver}\n${receiver}`);
  for (const [a, b] of drawRules.exclude) ban(a, b), ban(b, a);
  for (const [a, b] of drawRules.block) ban(a, b);
  for (const draw of previousDraws) for (const [giver, receiver] of Object.entries(draw)) ban(giver, receiver);
  for (const [giver, receiver] of avoid) ban(giver, receiver);

  const allowed = (giver, receiver, draw) =>
    giver !== receiver && !banned.has(`${giver}\n${receiver}`) && !(drawRules.noMutualPairs && draw[receiver] === giver);

  // Only random shuffles, so every valid draw has the same chance. If none fits, there's no draw.
  const givers = names.filter((giver) => !(giver in kept));
  const open = names.filter((receiver) => !Object.values(kept).includes(receiver));
  for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt++) {
    const receivers = shuffle([...open]);
    const draw = { ...kept, ...Object.fromEntries(givers.map((giver, i) => [giver, receivers[i]])) };
    if (names.every((giver) => allowed(giver, draw[giver], draw))) return draw;
  }
  return null;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function newPassword(people) {
  const taken = new Set(people.map((person) => person.password));
  let password;
  do {
    password = [...shuffle([...WORDS]).slice(0, 3), randomInt(10, 100)].join('-');
  } while (taken.has(password));
  return password;
}

// Terminal input

let pipedLines;

async function ask(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY) {
    pipedLines ??= readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
    process.stdout.write(question);
    const { value, done } = await pipedLines.next();
    process.stdout.write('\n');
    if (done) throw new AdminError('No more input.');
    return value;
  }
  if (hidden) return askHidden(question);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer;
}

function askHidden(question) {
  const { stdin, stdout } = process;
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve) => {
    let input = '';
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          resolve(input);
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') input = [...input].slice(0, -1).join('');
        else if (char >= ' ') input += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(question, defaultYes) {
  const answer = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return answer ? answer.startsWith('y') || answer.startsWith('j') : defaultYes;
}

// Main

const commands = { edit, draw, 'regen-password': regenPassword };
const [command, yearArg, ...rest] = process.argv.slice(2);

if (!commands[command]) {
  console.log(USAGE);
  process.exit(command && !['help', '--help', '-h'].includes(command) ? 1 : 0);
}
if (!/^\d{4}$/.test(yearArg ?? '')) {
  console.error(`Give a year, like: node admin.mjs ${command} ${new Date().getFullYear()}`);
  process.exit(1);
}

try {
  await commands[command](Number(yearArg), rest);
  process.exit(0);
} catch (error) {
  if (!(error instanceof AdminError)) throw error;
  console.error(error.message);
  process.exit(1);
}
