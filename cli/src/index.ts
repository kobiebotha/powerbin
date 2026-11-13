#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { CliError, revealLink, terminalText } from './client.js';

const help = `PowerBin — reveal a one-time message locally

Usage:
  powerbin reveal '<complete link, including #key>' [--raw]
  powerbin reveal --stdin [--raw]

Commands:
  reveal       Claim, decrypt, and burn a one-time message

Options:
  --stdin      Read the original link from standard input
  --raw        Write the exact message bytes without terminal formatting
  -h, --help   Show this help
  -v, --version Show the package version

The decryption key stays on this computer. Revealing consumes the link once.
Piped output contains only the exact message bytes; errors go to stderr.
`;

interface Arguments { url?: string; stdin: boolean; raw: boolean }

function argumentsForReveal(args: string[]): Arguments {
  const result: Arguments = { stdin: false, raw: false };
  for (const argument of args) {
    if (argument === '--raw' && !result.raw) result.raw = true;
    else if (argument === '--stdin' && !result.stdin) result.stdin = true;
    else if (argument.startsWith('-')) throw new CliError('Unknown or repeated option. Run powerbin --help for usage.', 2);
    else if (result.url === undefined) result.url = argument;
    else throw new CliError('Reveal accepts one link. Run powerbin --help for usage.', 2);
  }
  if (result.stdin === (result.url !== undefined)) {
    throw new CliError('Provide one complete link, or use --stdin to read it from standard input.', 2);
  }
  return result;
}

async function stdinLink(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > 8192) throw new CliError('Standard input must contain a single PowerBin link.', 2);
    chunks.push(bytes);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim(); }
  catch { throw new CliError('Standard input must contain a valid UTF-8 PowerBin link.', 2); }
}

async function writeMessage(bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(bytes, error => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]!))
    || (args[0] === 'reveal' && args.length === 2 && ['--help', '-h'].includes(args[1]!))) {
    process.stdout.write(help);
    return;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0]!)) {
    const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(`${packageInfo.version}\n`);
    return;
  }
  if (args[0] !== 'reveal') throw new CliError('Unknown command. Run powerbin --help for usage.', 2);
  const options = argumentsForReveal(args.slice(1));
  const url = options.stdin ? await stdinLink() : options.url!;
  const plaintext = await revealLink(url);
  try {
    if (process.stdout.isTTY && !options.raw) {
      process.stderr.write('PowerBin · one-time message\n\n');
      const visible = terminalText(new TextDecoder().decode(plaintext));
      await writeMessage(Buffer.from(visible + (visible.endsWith('\n') ? '' : '\n')));
    } else {
      await writeMessage(plaintext);
    }
  } catch {
    throw new CliError('The message was revealed, but writing it to standard output failed. The link has already burned.');
  } finally {
    plaintext.fill(0);
  }
}

// Stream write failures are reported through their callbacks instead of a stack trace.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
main().catch(error => {
  process.stderr.write(`PowerBin: ${error instanceof CliError ? error.message : 'The command could not complete.'}\n`);
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
