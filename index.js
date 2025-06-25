#!/usr/bin/env node

import inquirer from 'inquirer';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import { create } from 'xmlbuilder2';
import { fileURLToPath } from 'url';
import { isBinaryFileSync } from 'isbinaryfile';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default exclusions
const DEFAULT_EXCLUDES = ['node_modules', '.git', '.DS_Store'];
const DEFAULT_FILE_SIZE_LIMIT = 1024 * 1024; // 1MB

// Enhanced logger
const log = {
  info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  warn: (msg) => console.warn(`\x1b[33m[WARN]\x1b[0m ${msg}`),
  error: (msg) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`)
};

async function promptRepoSource() {
  const { source } = await inquirer.prompt([
    {
      type: 'list',
      name: 'source',
      message: 'Would you like to clone a GitHub repo or use a local path?',
      choices: ['Clone from GitHub', 'Use local path'],
    },
  ]);
  return source;
}

async function promptRepoUrl() {
  const { url } = await inquirer.prompt([
    {
      type: 'input',
      name: 'url',
      message: 'Enter the GitHub repository URL:',
    },
  ]);
  return url;
}

async function promptAuth() {
  const { needsAuth } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'needsAuth',
      message: 'Is this a private repository (requires authentication)?',
      default: false,
    },
  ]);
  if (!needsAuth) return null;
  const { username, token } = await inquirer.prompt([
    { type: 'input', name: 'username', message: 'GitHub username:' },
    { type: 'password', name: 'token', message: 'GitHub personal access token:' },
  ]);
  return { username, token };
}

async function promptLocalPath() {
  const { localPath } = await inquirer.prompt([
    {
      type: 'input',
      name: 'localPath',
      message: 'Enter the local path to the repository:',
      validate: input => fs.existsSync(input) ? true : 'Path does not exist.'
    },
  ]);
  return localPath;
}

async function promptExcludes(defaults) {
  const { excludes } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'excludes',
      message: 'Select folders/files to exclude from XML:',
      choices: defaults,
      default: defaults,
    },
  ]);
  return excludes;
}

async function promptFileSizeLimit() {
  const { fileSizeLimit } = await inquirer.prompt([
    {
      type: 'input',
      name: 'fileSizeLimit',
      message: 'Enter max file size to include (in bytes, default 1048576 = 1MB):',
      default: DEFAULT_FILE_SIZE_LIMIT,
      validate: input => isNaN(Number(input)) || Number(input) <= 0 ? 'Enter a positive number.' : true
    },
  ]);
  return Number(fileSizeLimit);
}

async function promptOutputFormat() {
  const { format } = await inquirer.prompt([
    {
      type: 'list',
      name: 'format',
      message: 'Select output format:',
      choices: ['XML', 'TXT'],
      default: 'XML',
    },
  ]);
  return format;
}

function walkDir(dir, excludes, fileSizeLimit, files = []) {
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(dir);
  } catch (err) {
    log.error(`Failed to read directory: ${dir} (${err.message})`);
    return files;
  }
  for (const file of dirEntries) {
    const fullPath = path.join(dir, file);
    const relPath = path.relative(process.cwd(), fullPath);
    if (excludes.some(ex => relPath.includes(ex))) {
      log.info(`Excluded: ${relPath}`);
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (err) {
      log.error(`Failed to stat: ${relPath} (${err.message})`);
      continue;
    }
    if (stat.isDirectory()) {
      files.push({ type: 'directory', name: file, path: relPath, children: walkDir(fullPath, excludes, fileSizeLimit, []) });
    } else {
      if (stat.size > fileSizeLimit) {
        log.warn(`Skipped (too large): ${relPath} (${stat.size} bytes)`);
        continue;
      }
      let isBinary = false;
      try {
        isBinary = isBinaryFileSync(fullPath);
      } catch (err) {
        log.error(`Binary check failed: ${relPath} (${err.message})`);
        continue;
      }
      if (isBinary) {
        log.warn(`Skipped (binary): ${relPath}`);
        continue;
      }
      let content = '';
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch (err) {
        log.error(`Failed to read: ${relPath} (${err.message})`);
        continue;
      }
      files.push({ type: 'file', name: file, path: relPath, content });
    }
  }
  return files;
}

function buildXmlTree(files) {
  function buildNode(node, xmlParent) {
    if (node.type === 'directory') {
      const dirElem = xmlParent.ele('directory', { name: node.name, path: node.path });
      node.children.forEach(child => buildNode(child, dirElem));
    } else {
      xmlParent.ele('file', { name: node.name, path: node.path }).txt(node.content);
    }
  }
  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('repository');
  files.forEach(f => buildNode(f, root));
  return root.end({ prettyPrint: true });
}

function buildTxtOutput(files, output = [], parentPath = '') {
  for (const node of files) {
    if (node.type === 'directory') {
      buildTxtOutput(node.children, output, path.join(parentPath, node.name));
    } else {
      output.push(`--- FILE: ${path.join(parentPath, node.name)} ---\n`);
      output.push(node.content + '\n');
    }
  }
  return output.join('');
}

async function main() {
  try {
    const source = await promptRepoSource();
    let repoPath = '';
    if (source === 'Clone from GitHub') {
      const url = await promptRepoUrl();
      const auth = await promptAuth();
      const tempDir = path.join(process.cwd(), 'temp_repo');
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      const git = simpleGit();
      let cloneUrl = url;
      if (auth) {
        try {
          const urlObj = new URL(url);
          urlObj.username = auth.username;
          urlObj.password = auth.token;
          cloneUrl = urlObj.toString();
        } catch (err) {
          log.error(`Invalid URL: ${url} (${err.message})`);
          return;
        }
      }
      try {
        log.info(`Cloning repository...`);
        await git.clone(cloneUrl, tempDir);
      } catch (err) {
        log.error(`Git clone failed: ${err.message}`);
        return;
      }
      repoPath = tempDir;
    } else {
      repoPath = await promptLocalPath();
    }
    const excludes = await promptExcludes(DEFAULT_EXCLUDES);
    const fileSizeLimit = await promptFileSizeLimit();
    log.info(`Walking directory and building file list...`);
    const files = walkDir(repoPath, excludes, fileSizeLimit);
    const outputFormat = await promptOutputFormat();
    let outputData;
    if (outputFormat === 'TXT') {
      log.info('Building TXT output...');
      outputData = buildTxtOutput(files);
    } else {
      log.info('Building XML tree...');
      outputData = buildXmlTree(files);
    }
    // Prompt for output directory: Desktop or custom
    const { outDirChoice } = await inquirer.prompt([
      {
        type: 'list',
        name: 'outDirChoice',
        message: 'Where do you want to save the output file?',
        choices: [
          { name: "Desktop", value: "desktop" },
          { name: "Specify a directory", value: "custom" }
        ],
        default: 'desktop'
      }
    ]);
    let outDir;
    if (outDirChoice === 'desktop') {
      outDir = path.join(os.homedir(), 'Desktop');
    } else {
      const { customDir } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customDir',
          message: 'Enter the output directory for the output file:',
          default: process.cwd()
        }
      ]);
      outDir = customDir;
    }
    const { outFile } = await inquirer.prompt([
      { type: 'input', name: 'outFile', message: `Enter output ${outputFormat} filename:`, default: outputFormat === 'TXT' ? 'repo.txt' : 'repo.xml' }
    ]);
    const outPath = path.join(outDir, outFile);
    try {
      fs.writeFileSync(outPath, outputData, 'utf8');
      log.info(`${outputFormat} file written to ${outPath}`);
      console.log('\x1b[32mSuccess!\x1b[0m Your file has been generated.');
    } catch (err) {
      log.error(`Failed to write output: ${err.message}`);
    }
    if (repoPath.endsWith('temp_repo')) {
      try {
        fs.rmSync(repoPath, { recursive: true, force: true });
        log.info(`Cleaned up temporary repo directory.`);
      } catch (err) {
        log.warn(`Failed to clean up temp repo: ${err.message}`);
      }
    }
  } catch (err) {
    log.error(`Fatal error: ${err.message}`);
  }
}

async function runApp() {
  let again = true;
  while (again) {
    await main();
    const { nextAction } = await inquirer.prompt([
      {
        type: 'list',
        name: 'nextAction',
        message: 'What would you like to do next?',
        choices: [
          { name: 'Transform another repo', value: 'again' },
          { name: 'Exit', value: 'exit' }
        ],
        default: 'exit'
      }
    ]);
    again = nextAction === 'again';
  }
  console.log('Goodbye!');
}

runApp();
