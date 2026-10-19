# Ubuntu terminal simulator

A single-file Ubuntu 26.04 LTS terminal that runs Bash commands and plain English requests in the browser. Nothing is uploaded. The language model runs on your own GPU.

## Run it

Open `index.html` in a modern browser. No build step, no server and no API key.

For the local model you need WebGPU:

- Chrome or Edge 113 and later, or Safari 18 and later
- hardware acceleration switched on
- a real GPU. Remote desktops and virtual machines without GPU passthrough usually fail

The page checks for a GPU adapter on load. If it cannot find one, it says why and keeps Bash working. Run `ai status` to check again.

## What it does

Every input takes one of two routes.

Route A handles Bash utilities. These run instantly against a file system held in JavaScript:

| Command | Notes |
| --- | --- |
| `ls` | supports `-a` and `-l` |
| `mkdir` | one or more directories |
| `touch` | creates empty files |
| `rm` | supports `-r` for directories |
| `rmdir` | empty directories only |
| `cd`, `pwd` | relative paths and `..` work |
| `cat`, `echo` | `echo` supports `>` and `>>` |
| `clear`, `help`, `date`, `whoami` | |

Route B handles everything else. Plain English goes to a local model, which returns JSON naming a command and its arguments. The simulator runs that command through the same Bash engine.

Examples:

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
- No pipes, redirection beyond `echo`, globbing or scripting.
- A 1B model reads simple, direct requests best. Name the folder or file you mean.

## Tests

The Bash engine and the AI reply parser are covered by a headless suite. The interface is covered by a jsdom suite that drives real keyboard events.
