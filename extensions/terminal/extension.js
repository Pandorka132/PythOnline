const vscode = require('vscode');

const ROOT = vscode.Uri.parse('pythonline:/workspace');
let terminal;
let terminalPty;

function normalize(path) {
  const parts = path.split('/').filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

function resolvePath(cwd, value) {
  if (!value) return cwd;
  return normalize(value.startsWith('/') ? value : cwd + '/' + value);
}

function uri(path) {
  return ROOT.with({ path });
}

async function exists(path) {
  try {
    await vscode.workspace.fs.stat(uri(path));
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  try {
    return (await vscode.workspace.fs.stat(uri(path))).type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

async function list(path) {
  return vscode.workspace.fs.readDirectory(uri(path));
}

async function readText(path) {
  const bytes = await vscode.workspace.fs.readFile(uri(path));
  return new TextDecoder().decode(bytes);
}

async function writeText(path, text) {
  await vscode.workspace.fs.writeFile(uri(path), new TextEncoder().encode(text));
}

async function mkdir(path) {
  await vscode.workspace.fs.createDirectory(uri(path));
}

async function rm(path, recursive = false) {
  await vscode.workspace.fs.delete(uri(path), { recursive });
}

async function cp(from, to) {
  await vscode.workspace.fs.copy(uri(from), uri(to), { overwrite: true });
}

async function mv(from, to) {
  await vscode.workspace.fs.rename(uri(from), uri(to), { overwrite: true });
}

function splitCommand(line) {
  const result = [];
  let current = '';
  let quote = null;
  let escape = false;

  for (const char of line.trim()) {
    if (escape) {
      current += char;
      escape = false;
    } else if (char === '\\') {
      escape = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) result.push(current);
  return result;
}

function makePty() {
  let cwd = '/workspace';

  const write = text => terminalPty?.write(text.replace(/\n/g, '\r\n'));
  const prompt = () => write('\\x1b[32m' + cwd + '\\x1b[0m $ ');

  async function execute(line) {
    const args = splitCommand(line);
    if (!args.length) {
      prompt();
      return;
    }

    const command = args.shift();

    try {
      switch (command) {
        case 'help':
          write('PythOnline terminal\n\nCommands: ls, cd, pwd, cat, mkdir, touch, rm, cp, mv, clear, echo, python\n');
          break;

        case 'pwd':
          write(cwd + '\n');
          break;

        case 'clear':
          terminalPty.write('\\x1b[2J\\x1b[H');
          break;

        case 'echo':
          write(args.join(' ') + '\n');
          break;

        case 'ls': {
          const target = resolvePath(cwd, args[0] || '.');
          const entries = await list(target);
          write(entries.map(([name, type]) => type === vscode.FileType.Directory ? name + '/' : name).join('  ') + '\n');
          break;
        }

        case 'cd': {
          const target = resolvePath(cwd, args[0] || '/workspace');
          if (!(await isDirectory(target))) throw new Error('cd: no such directory: ' + (args[0] || ''));
          cwd = target;
          break;
        }

        case 'cat':
          for (const file of args) write(await readText(resolvePath(cwd, file)));
          break;

        case 'touch':
          for (const file of args) {
            const path = resolvePath(cwd, file);
            if (!(await exists(path))) await writeText(path, '');
          }
          break;

        case 'mkdir':
          for (const dir of args) await mkdir(resolvePath(cwd, dir));
          break;

        case 'rm':
          for (const file of args.filter(x => x !== '-r' && x !== '-R' && x !== '-rf')) {
            const recursive = args.includes('-r') || args.includes('-R') || args.includes('-rf');
            await rm(resolvePath(cwd, file), recursive);
          }
          break;

        case 'cp':
          if (args.length !== 2) throw new Error('usage: cp SOURCE DEST');
          await cp(resolvePath(cwd, args[0]), resolvePath(cwd, args[1]));
          break;

        case 'mv':
          if (args.length !== 2) throw new Error('usage: mv SOURCE DEST');
          await mv(resolvePath(cwd, args[0]), resolvePath(cwd, args[1]));
          break;

        case 'python':
        case 'python3':
          if (!args.length) {
            write('Interactive Python is coming with the Pyodide terminal bridge.\n');
            break;
          }
          if (args.length !== 1 || !args[0].endsWith('.py')) {
            throw new Error('usage: python FILE.py');
          }
          const result = await vscode.commands.executeCommand('pythonline.runPythonPath', resolvePath(cwd, args[0]));
          if (result?.output) write(result.output);
          if (result?.error) write(result.error);
          break;

        default:
          write(command + ': command not found\n');
      }
    } catch (error) {
      write((error?.message || String(error)) + '\n');
    }

    prompt();
  }

  return {
    onDidWrite: () => {},
    open() {
      prompt();
    },
    close() {},
    handleInput(data) {
      if (data === '\\r' || data === '\\n') {
        write('\\r\\n');
        const line = terminalPty.buffer || '';
        terminalPty.buffer = '';
        void execute(line);
      } else if (data === '\\u007f') {
        if (terminalPty.buffer) {
          terminalPty.buffer = terminalPty.buffer.slice(0, -1);
          terminalPty.write('\\b \\b');
        }
      } else if (data === '\\u0003') {
        terminalPty.buffer = '';
        write('^C\\n');
        prompt();
      } else if (data >= ' ' && data !== '\\x7f') {
        terminalPty.buffer += data;
        terminalPty.write(data);
      }
    },
    buffer: ''
  };
}

async function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('pythonline.openTerminal', () => {
      if (!terminal) {
        terminalPty = makePty();
        terminal = vscode.window.createTerminal({
          name: 'PythOnline',
          pty: terminalPty
        });
        terminal.show();
        context.subscriptions.push(terminal);
      } else {
        terminal.show();
      }
    })
  );

  // Open the terminal once on first activation.
  await vscode.commands.executeCommand('pythonline.openTerminal');
}

module.exports = { activate };
