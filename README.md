# RepoToXML

This is a Node.js terminal application that converts a GitHub repository (public or private) or a local repository to a single XML file for LLM input.

## Features
- Clone from GitHub (supports authentication for private repos) or use a local path
- Outputs a single XML file with the full contents of each file
- Default exclusion list (node_modules, .git, etc.)
- XML output follows a standardized schema

## Usage

```sh
npm install
node index.js
```

Follow the prompts to select your repo and output options.