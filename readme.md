# Ubuntu terminal simulator

A single-file Ubuntu 26.04 LTS terminal that runs in the browser. It speaks Bash, a real POSIX shell, real Alpine packages and plain English. Nothing is uploaded. The language model runs on your own GPU.

## Run it

Open `index.html` in a modern browser. No build step, no server and no API key.

For the local model you need WebGPU:

- Chrome or Edge 113 and later, or Safari 18 and later
- hardware acceleration switched on
- a real GPU. Remote desktops and virtual machines without GPU passthrough usually fail

The page checks for a GPU adapter on load. If it cannot find one, it says why and keeps the other engines working. Run `ai status` to check again.

## What it does

Every input takes one of three routes.

### Route A: native Bash

These run instantly against a file system held in JavaScript:

| Command | Notes |
| --- | --- |
| `ls` | supports `-a` and `-l` |
| `mkdir` | supports `-p` for parent directories |
| `touch` | creates empty files |
| `rm` | supports `-r` for directories |
| `rmdir` | empty directories only |
| `cd`, `pwd` | relative paths and `..` work |
| `cat`, `echo` | `echo` supports `>` and `>>` |
| `clear`, `help`, `date`, `whoami` | |

Chain these with `&&`, `||` and `;`. Quoted operators stay literal.

```
mkdir demo && cd demo && touch a.txt && ls -l
ls missing || echo nothing here
mkdir a; mkdir b; ls
```

### Route B: POSIX shell

`sh -c` and `run` hand the text to a real interpreter over the same file system. It supports quoting, parameter expansion, command substitution, pipelines, redirection including `2>&1`, `&&` and `||`, `if`, `while`, `for`, `case`, functions, globbing and the usual builtins.

```
sh -c "for f in /etc/*; do echo $f; done"
sh -c "echo hello | tr a-z A-Z"
sh -c "if [ -d Documents ]; then echo yes; fi"
```

### Route C: apk packages

`apk` fetches real packages from the Alpine Linux CDN, verifies them and unpacks them into the file system. The whole chain runs in the browser:

- the gzip index and the package signatures are checked against the pinned Alpine keys
- the per-file payload checksums are checked
- the package files land in the file system, so `cat`, `ls` and the shell can read them
- maintainer scripts are captured and can be run

```
apk help                 every subcommand
apk update               fetch and verify the repository index
apk search alpine-conf   search by name or description
apk info alpine-conf     version, size, licence, dependencies
apk add alpine-conf      download, verify and install
apk list                 installed packages
apk del alpine-conf      remove a package
run /usr/sbin/lbu --help run a script the package provided
```

Alpine sends no `Access-Control-Allow-Origin` header, so a browser blocks a direct fetch. Set a CORS proxy once:

```
apk proxy https://your-proxy.example/?url=%s
```

Use `%s` where the target URL goes. Without it, the target URL is appended. Run `apk status` to see the repository, branch and proxy in use.

### Plain English

Any other input is read as intent. A local model returns JSON naming a command and its arguments. The simulator runs that command through the Bash engine.

```
create a folder called invoices
list everything in this directory
make an empty file named budget.txt
delete the folder called invoices
```

## Commands for the simulator itself

```
ai status      show the engine state
ai on          enable the Kernel AI
ai off         disable the Kernel AI
ai load        download and compile the model now
model          list the available models
model <id>     switch model
vfs            print the file system tree
shell          how to use the POSIX shell
reset          restore the factory file system
```

## How the model is grounded

The model gets a fixed system prompt and the current file system as text. It must reply with one JSON object and nothing else, such as:

```json
{"bash": "mkdir", "argument": "invoices"}
```

The sampler runs at `temperature: 0.0` for repeatable output. The simulator reads the first balanced JSON object out of the reply, so stray prose or code fences do not break it. If the reply has no usable JSON, the terminal explains what happened and stays usable.

The default model is `Llama-3.2-1B-Instruct-q4f16_1-MLC`. It downloads once, then loads from the browser cache. The download progress streams into the terminal.

## Limits

- The file system lives in memory and resets on reload. Use `reset` to restore it by hand.
- Packages carry compiled binaries for Linux. The browser cannot execute them, so only the shell scripts a package provides can run.
- Installing a package does not resolve dependencies automatically. The terminal lists any that are missing.
- A 1B model reads simple, direct requests best. Name the folder or file you mean.

## Tests

Three headless suites cover the code.

| Suite | What it checks | Tests |
| --- | --- | --- |
| `engine.test.mjs` | base64, SHA-1, gzip, tar, package install, signatures, checksums | 55 |
| `shell.test.mjs` | tokenizer, expansions, pipelines, redirection, control flow, builtins | 78 |
| `e2e.test.mjs` | the real `index.html` in jsdom, driven by real keyboard events | 49 |

The engine suites test the shipped `index.html`, not a copy. `test-harness.mjs`
slices the shell and apk sections out of it at run time.

Install and run:

```
npm install
npm test
```

The suites download three real Alpine packages on first run and cache them in
`fixtures/`. They are not committed. Run `node fetch-fixtures.mjs` to fetch them
on their own.
