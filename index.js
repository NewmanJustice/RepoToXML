#!/usr/bin/env node

import inquirer from 'inquirer';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import { create } from 'xmlbuilder2';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default exclusions
const DEFAULT_EXCLUDES = ['node_modules', '.git', '.DS_Store'];

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

function walkDir(dir, excludes, files = []) {
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);
    const relPath = path.relative(process.cwd(), fullPath);
    if (excludes.some(ex => relPath.includes(ex))) return;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      files.push({ type: 'directory', name: file, path: relPath, children: walkDir(fullPath, excludes, []) });
    } else {
      files.push({ type: 'file', name: file, path: relPath, content: fs.readFileSync(fullPath, 'utf8') });
    }
  });
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

async function main() {
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
      const urlObj = new URL(url);
      urlObj.username = auth.username;
      urlObj.password = auth.token;
      cloneUrl = urlObj.toString();
    }
    await git.clone(cloneUrl, tempDir);
    repoPath = tempDir;
  } else {
    repoPath = await promptLocalPath();
  }
  const excludes = await promptExcludes(DEFAULT_EXCLUDES);
  const files = walkDir(repoPath, excludes);
  const xml = buildXmlTree(files);
  const { outDir, outFile } = await inquirer.prompt([
    { type: 'input', name: 'outDir', message: 'Enter the output directory for the XML file:', default: process.cwd() },
    { type: 'input', name: 'outFile', message: 'Enter output XML filename:', default: 'repo.xml' }
  ]);
  const outPath = path.join(outDir, outFile);
  fs.writeFileSync(outPath, xml, 'utf8');
  console.log(`XML file written to ${outPath}`);
  if (repoPath.endsWith('temp_repo')) fs.rmSync(repoPath, { recursive: true, force: true });
}

main();
