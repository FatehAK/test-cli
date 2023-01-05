import { resolve, join, sep } from 'pathe';
import fetch from 'node-fetch';
import fs from 'fs-extra';
import { execa } from 'execa';
import minimatch from 'minimatch';
import ansi from 'ansi-colors';
import { GITHUB_DIR_TYPE, GITHUB_FILE_TYPE } from './constants';

export function escapeRegex(string) {
  return string.replace(/[.*+\-?^${}()[\]\\]/g, '\\$&');
}

export async function getLocalTemplates(templatePath) {
  const filesAndDirs = await fs.readdir(templatePath);
  return filesAndDirs
    .filter(fd => fs.lstatSync(templatePath + sep + fd).isDirectory())
    .map(t => ({ name: t, path: templatePath + sep + t }));
}

export async function callGitHubApi(url, token, raw = false) {
  const headers = { accept: `application/vnd.github.${raw ? 'raw' : 'json'}` };
  if (token) headers.Authorization = `token ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Error calling GitHub API - ${response.statusText} | ${response.url}`);

  if (raw) return await response.text();
  return await response.json();
}

const checkForPkgManager = filePath => {
  if (filePath.includes('package-lock.json')) return 'npm';
  if (filePath.includes('yarn.lock')) return 'yarn';
  if (filePath.includes('pnpm-lock.yaml')) return 'pnpm';
  return false;
};

export async function downloadDirectory(url, targetDir, config) {
  // create a folder if not exists
  await fs.ensureDir(targetDir);
  targetDir = resolve(targetDir);

  const contents = await callGitHubApi(url, config.githubToken);

  for (const content of contents) {
    if (content.type === GITHUB_FILE_TYPE) {
      const fileStr = await callGitHubApi(content.url, config.githubToken, true);
      const filePathAbs = join(targetDir, content.name);
      // check for pkg manager lock files
      const pkgManager = checkForPkgManager(filePathAbs);
      if (pkgManager) config.packageMap.push({ manager: pkgManager, path: targetDir });
      // replace slots in the file and write it
      fs.writeFile(filePathAbs, replaceSlots(filePathAbs, fileStr, config));
    } else if (content.type === GITHUB_DIR_TYPE) {
      await downloadDirectory(content.url, join(targetDir, content.name), config);
    } else {
      console.log(ansi.red(`\n Unknown type for ${ansi.bold(content.name)}`));
    }
  }
}

export async function copyDirectory(path, targetDir, config) {
  // create a folder if not exists
  await fs.ensureDir(targetDir);
  targetDir = resolve(targetDir);

  const contents = await fs.readdir(path);

  for (const content of contents) {
    const contentAbsPath = path + sep + content;
    if (fs.lstatSync(contentAbsPath).isFile()) {
      const fileStr = await fs.readFile(contentAbsPath, 'utf8');
      const filePathAbs = join(targetDir, content);
      // check for pkg manager lock files
      const pkgManager = checkForPkgManager(filePathAbs);
      if (pkgManager) config.packageMap.push({ manager: pkgManager, path: targetDir });
      // replace slots in the file and write it
      fs.writeFile(filePathAbs, replaceSlots(filePathAbs, fileStr, config));
    } else if (fs.lstatSync(contentAbsPath).isDirectory()) {
      await copyDirectory(contentAbsPath, join(targetDir, content), config);
    } else {
      console.log(ansi.red(`\n Unknown type for ${ansi.bold(content)}`));
    }
  }
}

function replaceSlots(filePath, content, config) {
  if (config.slotPaths?.some(pattern => minimatch(filePath, pattern))) {
    const { customSlots = {} } = config;
    const slots = {
      '[REPO_NAME]': config.repoName.trim(),
      '[AUTHOR_NAME]': config.authorName.trim(),
      ...customSlots,
    };
    const regex = new RegExp(escapeRegex(Object.keys(slots).join('|')), 'g');
    return content.replace(regex, match => slots[match]);
  }
  return content;
}

export async function initializeGit(targetDir) {
  const result = await execa('git', ['init'], { cwd: targetDir });
  if (result.failed) return Promise.reject(new Error('Failed to initialize git'));
  return true;
}

export async function installPackages(pkgManager, targetDir) {
  const result = await execa(pkgManager, ['install'], { cwd: targetDir });
  if (result.failed) return Promise.reject(new Error('Failed to install packages'));
  return true;
}
