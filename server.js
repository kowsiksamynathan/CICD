const express = require('express');
const session = require('express-session');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3456;

// Middleware
app.use(express.json());
app.use(
  session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 4 * 60 * 60 * 1000, // 4 hours
    },
  })
);

// Serve static files — but login.html is public, index.html requires auth
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
// Repo state
// ──────────────────────────────────────────────
const REPOS_DIR = path.join(__dirname, '.repos');
let currentRepo = {
  url: null,
  localPath: null,
  ready: false,
};

if (!fs.existsSync(REPOS_DIR)) {
  fs.mkdirSync(REPOS_DIR, { recursive: true });
}

// ──────────────────────────────────────────────
// Mutex
// ──────────────────────────────────────────────
class Mutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }
  get locked() { return this._locked; }
  get queueLength() { return this._queue.length; }
  acquire() {
    return new Promise((resolve) => {
      if (!this._locked) { this._locked = true; resolve(); }
      else { this._queue.push(resolve); }
    });
  }
  release() {
    if (this._queue.length > 0) { this._queue.shift()(); }
    else { this._locked = false; }
  }
}

const operationMutex = new Mutex();

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function runCommand(command, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    
    exec(command, { cwd, timeout: 300000, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        reject({ message: error.message, stdout: stdout?.trim() || '', stderr: stderr?.trim() || '', code: error.code });
      } else {
        resolve({ stdout: stdout?.trim() || '', stderr: stderr?.trim() || '' });
      }
    });
  });
}

async function runCommands(commands, cwd, extraEnv = {}) {
  const results = [];
  for (const cmd of commands) {
    const result = await runCommand(cmd, cwd, extraEnv);
    results.push({ command: cmd, ...result });
  }
  return results;
}

function repoDirName(url) {
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
  const name = url.replace(/^https?:\/\//, '').replace(/\.git$/, '').replace(/[^a-zA-Z0-9]/g, '_');
  return `${name.slice(0, 40)}_${hash}`;
}

// ─── Operation Logger ───
const LOG_FILE = path.join(__dirname, 'operations.log');

function logOperation(user, operation, details) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] user=${user} op=${operation} ${JSON.stringify(details)}\n`;
  fs.appendFileSync(LOG_FILE, line, 'utf-8');
}

function requireRepo(res) {
  if (!currentRepo.ready || !currentRepo.localPath) {
    res.status(400).json({ success: false, message: 'No repository connected. Please connect a repository first.' });
    return false;
  }
  return true;
}

// Build a credential-embedded URL from a repo URL and session creds
function buildAuthUrl(repoUrl, username, password) {
  try {
    const url = new URL(repoUrl);
    url.username = encodeURIComponent(username);
    url.password = encodeURIComponent(password);
    return url.toString();
  } catch (_) {
    // If URL parsing fails, do manual insertion
    return repoUrl.replace('://', `://${encodeURIComponent(username)}:${encodeURIComponent(password)}@`);
  }
}

// ──────────────────────────────────────────────
// Auth middleware
// ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.gitUser) {
    return next();
  }
  res.status(401).json({ success: false, message: 'Not authenticated. Please log in.' });
}

// ──────────────────────────────────────────────
// AUTH ROUTES (public)
// ──────────────────────────────────────────────

// GET /api/auth-status
app.get('/api/auth-status', (req, res) => {
  if (req.session && req.session.gitUser) {
    res.json({ authenticated: true, username: req.session.gitUser });
  } else {
    res.json({ authenticated: false, username: null });
  }
});

// POST /api/login — validate Git credentials
app.post('/api/login', async (req, res) => {
  const { username, password, repoUrl } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  // Use a known repo URL to validate credentials via git ls-remote
  const testUrl = repoUrl || 'https://zrepository.zohocorpcloud.in/zohocorp/ZohoCanvas/crm-canvas.git';
  const authUrl = buildAuthUrl(testUrl, username, password);

  try {
    await runCommand(`git ls-remote "${authUrl}" HEAD`, __dirname);
    // Credentials are valid
    req.session.gitUser = username;
    req.session.gitPass = password;
    res.json({ success: true, message: `Authenticated as ${username}.` });
  } catch (err) {
    const errMsg = err.stderr || err.message || '';
    if (errMsg.includes('Authentication failed') || errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('fatal:')) {
      res.status(401).json({ success: false, message: 'Invalid Git credentials. Please check your username and password.' });
    } else {
      res.status(500).json({ success: false, message: `Login failed: ${errMsg}` });
    }
  }
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true, message: 'Logged out.' });
  });
});

// ──────────────────────────────────────────────
// ALL ROUTES BELOW REQUIRE AUTH
// ──────────────────────────────────────────────
app.use('/api', requireAuth);

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    repo: { url: currentRepo.url, ready: currentRepo.ready },
    queue: { busy: operationMutex.locked, waiting: operationMutex.queueLength },
    user: req.session.gitUser,
  });
});

// POST /api/connect
app.post('/api/connect', async (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl) return res.status(400).json({ success: false, message: 'Repository URL is required.' });

  const username = req.session.gitUser;
  const password = req.session.gitPass;
  const authUrl = buildAuthUrl(repoUrl, username, password);

  if (currentRepo.ready && currentRepo.url === repoUrl) {
    return res.json({ success: true, message: 'Already connected to this repository.', alreadyCloned: true });
  }

  await operationMutex.acquire();
  try {
    const dirName = repoDirName(repoUrl);
    const localPath = path.join(REPOS_DIR, dirName);

    if (fs.existsSync(path.join(localPath, '.git'))) {
      // Update remote URL with current credentials
      try {
        await runCommand(`git remote set-url origin "${authUrl}"`, localPath);
        await runCommand('git fetch --all', localPath);
      } catch (_) {}
      currentRepo = { url: repoUrl, localPath, ready: true };
      return res.json({ success: true, message: 'Repository already cloned. Fetched latest.', alreadyCloned: true });
    }

    await runCommand(`git clone "${authUrl}" "${localPath}"`);
    // Set the remote to the plain URL (credentials injected per-operation)
    await runCommand(`git remote set-url origin "${authUrl}"`, localPath);
    currentRepo = { url: repoUrl, localPath, ready: true };

    res.json({ success: true, message: 'Repository cloned successfully.', alreadyCloned: false });
  } catch (err) {
    currentRepo = { url: null, localPath: null, ready: false };
    res.status(500).json({ success: false, message: `Failed to clone: ${err.stderr || err.message}`, details: err });
  } finally {
    operationMutex.release();
  }
});

// POST /api/disconnect
app.post('/api/disconnect', (req, res) => {
  currentRepo = { url: null, localPath: null, ready: false };
  res.json({ success: true, message: 'Disconnected.' });
});

// GET /api/branches
app.get('/api/branches', async (req, res) => {
  if (!requireRepo(res)) return;
  try {
    const cwd = currentRepo.localPath;
    try { await runCommand('git fetch --all --prune', cwd); } catch (_) {}
    const result = await runCommand('git branch -r --no-color', cwd);
    const branches = result.stdout.split('\n').map(b => b.trim()).filter(b => b && !b.includes('->')).map(b => b.replace(/^origin\//, '')).sort();
    res.json({ success: true, branches });
  } catch (err) {
    res.status(500).json({ success: false, message: `Failed to list branches: ${err.stderr || err.message}`, branches: [] });
  }
});

// POST /api/get-version
app.post('/api/get-version', async (req, res) => {
  if (!requireRepo(res)) return;
  const { branch, tagging } = req.body;
  if (!branch) return res.status(400).json({ success: false, message: 'Branch name is required.' });
  try {
    const result = await runCommand(`git show origin/${branch}:webapps/crm-canvas-client/package.json`, currentRepo.localPath);
    const version = JSON.parse(result.stdout).version || '0.0.0';
    res.json({ success: true, version });
  } catch (err) {
    res.status(500).json({ success: false, message: `Failed to read version: ${err.stderr || err.message}`, version: null });
  }
});

// POST /api/increment-version
app.post('/api/increment-version', async (req, res) => {
  if (!requireRepo(res)) return;
  const { branch, message, newVersion } = req.body;
  if (!branch) return res.status(400).json({ success: false, message: 'Branch name is required.' });
  if (!message) return res.status(400).json({ success: false, message: 'Commit message is required.' });
  if (!newVersion) return res.status(400).json({ success: false, message: 'New version is required.' });
  if (!/^\d+\.\d+\.\d+/.test(newVersion)) return res.status(400).json({ success: false, message: 'Invalid version format.' });

  // Ensure remote has credentials
  const authUrl = buildAuthUrl(currentRepo.url, req.session.gitUser, req.session.gitPass);

  await operationMutex.acquire();
  try {
    const cwd = currentRepo.localPath;
    const username = req.session.gitUser + "@zohocorp.com";

    await runCommands([
      `git checkout ${branch}`,
      `git reset --hard origin/${branch}`,
      `git clean -fd`,
      `git pull "${authUrl}" ${branch}`,
    ], cwd);

    const pkgPath = path.join(cwd, '/webapps/crm-canvas-client/package.json');
    if (!fs.existsSync(pkgPath)) throw { message: 'package.json not found.', stderr: 'package.json not found', stdout: '' };

    const pkgRaw = fs.readFileSync(pkgPath, 'utf-8');
    const oldVersion = JSON.parse(pkgRaw).version || '0.0.0';
    const updatedRaw = pkgRaw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${newVersion}"`);
    fs.writeFileSync(pkgPath, updatedRaw, 'utf-8');

    await runCommands([
      `git add webapps/crm-canvas-client/package.json`,
      `git -c user.name="${username}" -c user.email="${username}" commit -m "${message}" -n`,
      `git push "${authUrl}" ${branch}`,
    ], cwd);

    logOperation(req.session.gitUser, 'increment-version', { branch, oldVersion, newVersion, message, status: 'success' });
    res.json({ success: true, message: `Version updated ${oldVersion} → ${newVersion} and pushed to ${branch}.`, details: [] });
  } catch (err) {
    logOperation(req.session.gitUser, 'increment-version', { branch, newVersion, message, status: 'failed', error: err.stderr || err.message });
    res.status(500).json({ success: false, message: `Failed: ${err.stderr || err.message}`, details: err });
  } finally {
    operationMutex.release();
  }
});

// POST /api/cherry-pick
app.post('/api/cherry-pick', async (req, res) => {
  if (!requireRepo(res)) return;
  const { branch, commitId } = req.body;
  if (!branch) return res.status(400).json({ success: false, message: 'Target branch is required.' });
  if (!commitId) return res.status(400).json({ success: false, message: 'Commit ID is required.' });
  if (!/^[0-9a-fA-F]{4,40}$/.test(commitId)) return res.status(400).json({ success: false, message: 'Invalid commit ID format.' });

  const authUrl = buildAuthUrl(currentRepo.url, req.session.gitUser, req.session.gitPass);

  await operationMutex.acquire();
  try {
    const cwd = currentRepo.localPath;
    const username = req.session.gitUser + "@zohocorp.com";

    const results = await runCommands([
      `git checkout ${branch}`,
      `git reset --hard origin/${branch}`,
      `git clean -fd`,
      `git pull "${authUrl}" ${branch}`,
      `git -c user.name="${username}" -c user.email="${username}" cherry-pick ${commitId}`,
      `git push "${authUrl}" ${branch}`,
    ], cwd);

    logOperation(req.session.gitUser, 'cherry-pick', { branch, commitId, status: 'success' });
    res.json({ success: true, message: `Commit ${commitId} cherry-picked onto ${branch} and pushed.`, details: results });
  } catch (err) {
    const cwd = currentRepo.localPath;
    let errorMessage = err.stderr || err.message;
    if (errorMessage.includes('CONFLICT') || errorMessage.includes('cherry-pick')) {
      try { await runCommand('git cherry-pick --abort', cwd); } catch (_) {}
      errorMessage = `Cherry-pick conflict. Aborted. Details: ${errorMessage}`;
    }
    logOperation(req.session.gitUser, 'cherry-pick', { branch, commitId, status: 'failed', error: errorMessage });
    res.status(500).json({ success: false, message: errorMessage, details: err });
  } finally {
    operationMutex.release();
  }
});

// POST /api/publish
app.post('/api/publish', async (req, res) => {
  if (!requireRepo(res)) return;
  const { branch, tagging } = req.body;
  if (!branch) return res.status(400).json({ success: false, message: 'Branch name is required.' });

  const authUrl = buildAuthUrl(currentRepo.url, req.session.gitUser, req.session.gitPass);

  await operationMutex.acquire();
  try {
    const cwd = currentRepo.localPath;

    const gitResults = await runCommands([
      `git checkout ${branch}`,
      `git reset --hard origin/${branch}`,
      `git clean -fd`,
      `git pull "${authUrl}" ${branch}`,
    ], cwd);

    const taggingAnswer = tagging === 'y' ? 'y' : 'n';
    const publishDir = path.join(cwd,'/webapps/crm-canvas-client');

    // Delete blog folder if present
    const blogDir = path.join(publishDir, 'blog');
    if (fs.existsSync(blogDir)) {
      fs.rmSync(blogDir, { recursive: true, force: true });
    }


    const publishResult = await new Promise((resolve, reject) => {
      const child = require('child_process').spawn('npm', ['publish', '--registry', 'http://cm-npmregistry.csez.zohocorpin.com  --tag beta '], {
        cwd: publishDir,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 300000,
      });
      let stdout = '', stderr = '';
      let promptsAnswered = 0;
      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        // Detect prompts containing "branch?"
        if (chunk.includes('branch?') && promptsAnswered < 2) {
          promptsAnswered++;
          if (promptsAnswered === 1) {
            child.stdin.write('y\n');
          } else if (promptsAnswered === 2) {
            child.stdin.write(taggingAnswer + '\n');
          }
        }
      });
      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        // Some npm versions write prompts to stderr
        if (chunk.includes('branch?') && promptsAnswered < 2) {
          promptsAnswered++;
          if (promptsAnswered === 1) {
            child.stdin.write('y\n');
          } else if (promptsAnswered === 2) {
            child.stdin.write(taggingAnswer + '\n');
          }
        }
      });
      child.on('close', (code) => {
        if (code === 0) resolve({ command: 'npm publish', stdout: stdout.trim(), stderr: stderr.trim() });
        else reject({ message: `npm publish exited with code ${code}`, stdout: stdout.trim(), stderr: stderr.trim(), code });
      });
      child.on('error', (err) => reject({ message: err.message, stdout, stderr }));
    });
    const publishResults = [publishResult];






    logOperation(req.session.gitUser, 'publish', { branch, tagging: taggingAnswer, status: 'success' });
    res.json({ success: true, message: `Published from branch ${branch}.`, details: [...gitResults, ...publishResults] });
  } catch (err) {
    logOperation(req.session.gitUser, 'publish', { branch, tagging, status: 'failed', error: err.stderr || err.message });
    res.status(500).json({ success: false, message: `Publish failed: ${err.stderr || err.message}`, details: err });
  } finally {
    operationMutex.release();
  }
});

// ──────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────
app.listen(3456, '0.0.0.0', () => {
  console.log(`🚀 Git & NPM Tool running at http://localhost:${PORT}`);
});