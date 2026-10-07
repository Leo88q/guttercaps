# Self-Hosted Runner Setup for G-3 Soak Bot

> **Status**: Required for production G-3 soak testing
> **Node Requirement**: 24+ (SEC-B50)
> **Last Updated**: 2026-10-07

---

## 🎯 Overview

The G-3 soak bot requires **14 days of continuous execution** to validate:
- ≥ 10,000 packs purchased
- ≥ 500 fusions (≥ 100 risky)
- ≥ 200 wager matches
- 0 abandoned/stale pending
- crank p95 ≤ 20 seconds

GitHub Actions **free runners** have limitations:
- **6 hours max per job** (G-3 needs 14 days × 24 hours = 336 hours)
- **No persistent storage** (state lost between runs)
- **Rate limits** on public devnet RPC

**Solution**: Self-hosted runner with:
- Long-running job support
- Persistent storage
- Dedicated devnet RPC access
- All required toolchains (Node 24, Rust 1.89, Solana 2.1.0, Anchor 0.31.1)

---

## 🚀 Quick Start

### Option A: Use Setup Workflow

1. **Create a PAT token** with `repo` scope:
   ```
   https://github.com/settings/tokens/new
   ```

2. **Add PAT as secret**: `SELF_HOSTED_RUNNER_TOKEN`
   ```
   https://github.com/Leo88q/guttercaps/settings/secrets/actions/new
   ```

3. **Run setup workflow**:
   ```bash
   gh workflow run setup-self-hosted.yml \
     -f runner_name=g3-soak-runner \
     -f labels="self-hosted,g3-soak,anchor"
   ```

4. **Download and run setup script** on target machine:
   ```bash
   # From workflow artifacts
   wget <artifact-url>/setup-runner.sh
   chmod +x setup-runner.sh
   ./setup-runner.sh
   ```

### Option B: Manual Setup

Run on target machine (Ubuntu 22.04 LTS recommended):

```bash
# 1. Update system
sudo apt-get update -y && sudo apt-get upgrade -y

# 2. Install basic dependencies
sudo apt-get install -y curl wget git build-essential pkg-config \
  libssl-dev libudev-dev zlib1g-dev llvm clang cmake make \
  g++ jq unzip tar

# 3. Install Node 24 (via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
nvm alias default 24

# 4. Install Rust 1.89.0
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.89.0
source "$HOME/.cargo/env"

# 5. Install Solana CLI 2.1.0 (Agave)
curl -sSfL https://raw.githubusercontent.com/solana-labs/solana/v2.1.0/install | sh -s -- --install-dir /usr/local

# 6. Install Anchor 0.31.1
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --locked --force
avm use 0.31.1

# 7. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for docker group to take effect

# 8. Install GitHub Actions Runner
mkdir -p ~/actions-runner && cd ~/actions-runner
RUNNER_TOKEN=<your-pat-token>
REPO_URL=https://github.com/Leo88q/guttercaps
RUNNER_NAME=g3-soak-runner
curl -o actions-runner.tar.gz -L https://github.com/actions/runner/releases/download/v2.311.0/actions-runner-linux-x64-2.311.0.tar.gz
tar xzf actions-runner.tar.gz
./config.sh --url $REPO_URL --token $RUNNER_TOKEN --name $RUNNER_NAME --labels self-hosted,g3-soak,anchor --unattended
rm -f actions-runner.tar.gz

# 9. Start runner
./run.sh

# (Optional) Install as service
sudo ./svc.sh install
sudo ./svc.sh start
```

---

## 📋 Requirements

### Hardware Requirements

| Component | Minimum | Recommended | Notes |
|-----------|---------|-------------|-------|
| CPU | 2 cores | 4+ cores | More workers = more CPU |
| RAM | 4 GB | 8+ GB | Node + Rust compilation |
| Storage | 40 GB | 100+ GB | Docker images, target/, logs |
| OS | Ubuntu 20.04+ | Ubuntu 22.04 LTS | Tested on 22.04 |
| Architecture | x86_64 | x86_64 | Required for Solana |

### Software Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 24+ | SEC-B50 compliance |
| npm | 10+ | Package management |
| Rust | 1.89.0 | Anchor compilation |
| Solana CLI | 2.1.0 | Devnet interaction |
| Anchor | 0.31.1 | Program building |
| Docker | 20+ | Container support |
| Git | 2.x | Version control |

---

## 🔧 Configuration

### Runner Labels

Use labels to target specific workflows to this runner:

```yaml
# In workflow file
jobs:
  soak:
    runs-on: [self-hosted, g3-soak]
```

Recommended labels:
- `self-hosted` — Required for all self-hosted runners
- `g3-soak` — For G-3 soak bot workflows
- `anchor` — For Anchor-related workflows
- `devnet` — For devnet-specific workflows

### Environment Variables

Set these as **repository secrets** or **organization secrets**:

| Variable | Required | Description |
|----------|----------|-------------|
| `SELF_HOSTED_RUNNER_TOKEN` | ✅ | PAT for runner registration |
| `DEVNET_RPC_URL` | ✅ | Private devnet RPC endpoint |
| `SOAK_PRIVATE_KEY` | ✅ | Funded wallet private key |

---

## 🏗️ Setup Details

### 1. Node 24 Installation

**Why Node 24?**
- SEC-B50 requirement
- Backend uses `node:sqlite` (experimental before Node 22.13, stable in 24+)
- Modern JavaScript features

**Verification:**
```bash
node -v  # Should output v24.x.x
npm -v  # Should output 10.x.x+
```

### 2. Rust 1.89.0 Installation

**Why this version?**
- Matches `rust-toolchain.toml` in repository
- Compatible with Anchor 0.31.1
- Supports all required features

**Verification:**
```bash
rustc --version  # Should output 1.89.0
cargo --version # Should output 1.89.0
```

### 3. Solana CLI 2.1.0 (Agave)

**Why Agave?**
- Solana Foundation's maintained release
- Stable and tested
- Required for devnet interaction

**Verification:**
```bash
solana --version  # Should output 2.1.0
solana config get  # Should show devnet as default
```

**Configuration:**
```bash
# Set devnet as default
solana config set --url devnet
```

### 4. Anchor 0.31.1 Installation

**Why this version?**
- Matches `Anchor.toml` in repository
- Compatible with program dependencies

**Verification:**
```bash
anchor --version  # Should output 0.31.1
avm list          # Should show 0.31.1 as active
```

### 5. Docker Installation

**Why Docker?**
- Containerized execution
- Consistent environment
- Isolation from host system

**Verification:**
```bash
docker --version
docker compose version
docker run hello-world
```

---

## 📊 Monitoring

### Runner Status

Check runner status:

```bash
# On the runner machine
cd ~/actions-runner
./run.sh --check

# Or via GitHub API
gh api repos/Leo88q/guttercaps/actions/runners
```

### Logs

**Runner logs:**
```bash
# On the runner machine
cd ~/actions-runner
./run.sh --loglevel debug

# View logs in real-time
tail -f _diag/Runner_*.log
```

**Workflow logs:**
```bash
# View workflow runs
gh run list --workflow g3-soak.yml

# View specific run logs
gh run view <run-id>
```

---

## 🔄 Maintenance

### Updating Dependencies

```bash
# Update Node
nvm install 24
nvm use 24
nvm alias default 24

# Update Rust
rustup update 1.89.0

# Update Solana
solana-install update 2.1.0

# Update Anchor
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --locked --force
avm use 0.31.1

# Update Docker
sudo apt-get update -y
sudo apt-get upgrade -y docker-ce docker-ce-cli containerd.io
```

### Updating Runner

```bash
# On the runner machine
cd ~/actions-runner

# Remove old runner
./config.sh remove --token <token>

# Download new version
curl -o actions-runner.tar.gz -L https://github.com/actions/runner/releases/download/v2.311.0/actions-runner-linux-x64-2.311.0.tar.gz
tar xzf actions-runner.tar.gz

# Reconfigure
./config.sh --url $REPO_URL --token $RUNNER_TOKEN --name $RUNNER_NAME --labels self-hosted,g3-soak,anchor --unattended

# Restart
./run.sh
```

### Cleanup

```bash
# Remove runner
./config.sh remove --token <token>

# Remove runner directory
rm -rf ~/actions-runner

# Remove Docker containers
# (Be careful - this removes ALL containers)
docker system prune -a --volumes
```

---

## ⚠️ Troubleshooting

### "Runner not picking up jobs"

**Possible causes:**
1. Labels don't match workflow requirements
2. Runner not connected to GitHub
3. Token expired

**Solutions:**
```bash
# Check runner status
./run.sh --check

# Verify labels
./config.sh list

# Check GitHub connection
gh api repos/Leo88q/guttercaps/actions/runners
```

### "Permission denied when starting runner"

**Solution:**
```bash
# Make sure you have write permissions
chmod -R u+w ~/actions-runner

# Or run as root (not recommended)
sudo ./run.sh
```

### "Node version mismatch"

**Solution:**
```bash
# Use nvm to switch versions
nvm use 24
nvm alias default 24

# Verify
echo $PATH | grep nvm  # Should show nvm in PATH
```

### "Rust toolchain not found"

**Solution:**
```bash
# Check installed toolchains
rustup list

# Install required toolchain
rustup install 1.89.0
rustup default 1.89.0

# Verify
rustc --version
```

### "Solana command not found"

**Solution:**
```bash
# Check installation
which solana

# Reinstall
curl -sSfL https://raw.githubusercontent.com/solana-labs/solana/v2.1.0/install | sh -s -- --install-dir /usr/local

# Add to PATH
export PATH="/usr/local/bin:$PATH"
```

### "Anchor command not found"

**Solution:**
```bash
# Check installation
which anchor

# Reinstall
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --locked --force

# Use avm
avm list
avm use 0.31.1
```

---

## 📄 References

- [GitHub Actions Self-Hosted Runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners)
- [Anchor Installation](https://www.anchor-lang.com/docs/installation)
- [Solana CLI Installation](https://docs.solana.com/cli/install-solana-cli-tools)
- [G-3 Soak Bot](scripts/load/soak-g3.md)
- [Production Readiness](docs/09-production-readiness.md)

---

## 🎯 Next Steps

After setting up the self-hosted runner:

1. **Verify runner is online:**
   ```bash
   gh api repos/Leo88q/guttercaps/actions/runners
   ```

2. **Trigger a test workflow:**
   ```bash
   gh workflow run g3-soak.yml \
     -f duration_hours=1 \
     -f target_packs=100 \
     -f concurrency=2
   ```

3. **Monitor the run:**
   ```bash
   gh run watch
   ```

4. **For production G-3 soak:**
   ```bash
   gh workflow run g3-soak.yml \
     -f duration_hours=336 \  # 14 days
     -f target_packs=10000 \
     -f concurrency=10
   ```

---

## 💡 Tips

1. **Use a dedicated machine** — Don't run on your development machine
2. **Use a VM or cloud instance** — Recommended: Ubuntu 22.04 LTS on AWS/GCP/Azure
3. **Monitor resource usage** — Use `htop`, `df -h`, `docker stats`
4. **Set up alerts** — Monitor runner health and job failures
5. **Rotate tokens** — Regularly rotate PAT tokens for security
6. **Backup runner config** — Backup `~/actions-runner` directory
7. **Use private RPC** — Public devnet has rate limits; use QuickNode/Helius/Triton
8. **Fund the wallet** — Ensure the wallet has enough SOL for 10,000+ packs (150-200 SOL)

---

## 📞 Support

If you encounter issues:

1. Check the [troubleshooting section](#-troubleshooting)
2. Review the [workflow logs](#-monitoring)
3. Check the runner logs on the machine
4. Verify all dependencies are installed correctly
5. Ensure the runner has proper network access to GitHub and devnet RPC

For repository-specific questions, check:
- [docs/09-production-readiness.md](docs/09-production-readiness.md)
- [docs/MAC-DEVNET.md](docs/MAC-DEVNET.md)
- [scripts/load/soak-g3.md](scripts/load/soak-g3.md)
