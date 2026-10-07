/**
 * Unit tests for G-3 soak bot configuration
 * 
 * These tests verify the soak bot can be properly configured
 * and validate its environment requirements.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock environment variables
const originalEnv = process.env;

beforeAll(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('G-3 Soak Bot Configuration', () => {
  it('should have valid TypeScript syntax', () => {
    const soakBotPath = join(__dirname, 'soak-g3.ts');
    const content = readFileSync(soakBotPath, 'utf-8');
    
    // Basic syntax checks
    expect(content).toContain('async function runWorker');
    expect(content).toContain('async function main');
    expect(content).toContain('PROGRAM_IDS');
    expect(content).toContain('G-3');
    expect(content).toContain('SoakMetrics');
  });

  it('should export configuration interface', () => {
    const soakBotPath = join(__dirname, 'soak-g3.ts');
    const content = readFileSync(soakBotPath, 'utf-8');
    
    expect(content).toContain('DEVNET_RPC_URL');
    expect(content).toContain('PRIVATE_KEY');
    expect(content).toContain('SOAK_DURATION_DAYS');
    expect(content).toContain('SOAK_TARGET_PACKS');
    expect(content).toContain('SOAK_CONCURRENCY');
  });

  it('should have all required program IDs', () => {
    const soakBotPath = join(__dirname, 'soak-g3.ts');
    const content = readFileSync(soakBotPath, 'utf-8');
    
    // Check for actual program IDs from declare_id!
    expect(content).toContain('J68G8KrbLTSdi68LHr9Kkw1YbRRHv3uBPirWCd5Xt13V'); // chip_core
    expect(content).toContain('5skEmmhgFYn5xjHEdrcsiQ68kUg5kvhXKhjWTWSppjfo'); // market
    expect(content).toContain('Ewkbp7WpqbiJAu3ofEcTPinqnr5oH3e94YJDZFg1eSJn'); // staking
    expect(content).toContain('DUTokrhWBYL7nJ9VbMy7bFELQFf8TN1tmvVpKLsskqD6'); // arena
  });

  it('should have G-3 requirements defined', () => {
    const soakBotPath = join(__dirname, 'soak-g3.ts');
    const content = readFileSync(soakBotPath, 'utf-8');
    
    // Check G-3 targets
    expect(content).toContain('10000'); // TARGET_PACKS
    expect(content).toContain('500'); // Fusions target
    expect(content).toContain('100'); // Risky fusions target
    expect(content).toContain('200'); // Wager matches target
    expect(content).toContain('20000'); // 20 seconds in ms
  });

  it('should have operation functions', () => {
    const soakBotPath = join(__dirname, 'soak-g3.ts');
    const content = readFileSync(soakBotPath, 'utf-8');
    
    expect(content).toContain('async function buyAndOpenPack');
    expect(content).toContain('async function performFusion');
    expect(content).toContain('async function createWagerMatch');
  });

  it('should have monitoring functions', () => {
    const soakBotPath = join(__dirname, 'soak-g3.ts');
    const content = readFileSync(soakBotPath, 'utf-8');
    
    expect(content).toContain('checkPendingStates');
    expect(content).toContain('checkCrankMetrics');
  });

  it('should have metrics tracking', () => {
    const soakBotPath = join(__dirname, 'soak-g3.ts');
    const content = readFileSync(soakBotPath, 'utf-8');
    
    expect(content).toContain('interface SoakMetrics');
    expect(content).toContain('packsPurchased');
    expect(content).toContain('fusionsCompleted');
    expect(content).toContain('wagerMatches');
    expect(content).toContain('abandonedPending');
    expect(content).toContain('stalePending');
    expect(content).toContain('crankP95Ms');
  });

  it('should have G-3 gate validation', () => {
    const soakBotPath = join(__dirname, 'soak-g3.ts');
    const content = readFileSync(soakBotPath, 'utf-8');
    
    expect(content).toContain('G-3 Gate');
    expect(content).toContain('GATE VALIDATION');
    expect(content).toContain('allPass');
  });

  it('should have graceful shutdown', () => {
    const soakBotPath = join(__dirname, 'soak-g3.ts');
    const content = readFileSync(soakBotPath, 'utf-8');
    
    expect(content).toContain('SIGINT');
    expect(content).toContain('SIGTERM');
    expect(content).toContain('shutdown');
  });

  it('should have automatic airdrop', () => {
    const soakBotPath = join(__dirname, 'soak-g3.ts');
    const content = readFileSync(soakBotPath, 'utf-8');
   
    expect(content).toContain('requestAirdropIfLow');
    expect(content).toContain('getPayerBalance');
  });
});

describe('G-3 Pending-State Validator', () => {
  const validatorPath = join(__dirname, 'soak-validate.ts');

  it('should exist and query all three pending kinds on-chain', () => {
    const content = readFileSync(validatorPath, 'utf-8');

    expect(content).toContain('PendingPack');
    expect(content).toContain('PendingFusion');
    expect(content).toContain('WagerBattle');
    expect(content).toContain('getProgramAccounts');
    expect(content).toContain('STALE_SLOTS');
    expect(content).toContain('commit_slot');
  });

  it('should use Anchor account discriminators, not raw names', () => {
    const content = readFileSync(validatorPath, 'utf-8');

    expect(content).toContain("accountDiscriminator('PendingPack')");
    expect(content).toContain("accountDiscriminator('WagerBattle')");
  });

  it('should exit non-zero when stale pending is found', () => {
    const content = readFileSync(validatorPath, 'utf-8');

    expect(content).toContain('process.exit(allClean ? 0 : 1)');
  });
});

describe('G-3 Soak Bot Documentation', () => {
  it('should have setup guide', () => {
    const docPath = join(__dirname, 'soak-g3.md');
    const content = readFileSync(docPath, 'utf-8');
    
    expect(content).toContain('Quick Start');
    expect(content).toContain('Prerequisites');
    expect(content).toContain('DEVNET_RPC_URL');
    expect(content).toContain('PRIVATE_KEY');
  });

  it('should document G-3 requirements', () => {
    const docPath = join(__dirname, 'soak-g3.md');
    const content = readFileSync(docPath, 'utf-8');
    
    expect(content).toContain('G-3 Requirements');
    expect(content).toContain('≥ 10,000 packs');
    expect(content).toContain('≥ 500 fusions');
    expect(content).toContain('≥ 100 risky');
    expect(content).toContain('≥ 200 wager matches');
    expect(content).toContain('crank p95 ≤ 20');
  });

  it('should have troubleshooting section', () => {
    const docPath = join(__dirname, 'soak-g3.md');
    const content = readFileSync(docPath, 'utf-8');
    
    expect(content).toContain('Troubleshooting');
    expect(content).toContain('ERROR: PRIVATE_KEY');
    expect(content).toContain('Failed to connect to RPC');
    expect(content).toContain('Insufficient funds');
  });

  it('should have Docker deployment info', () => {
    const docPath = join(__dirname, 'soak-g3.md');
    const content = readFileSync(docPath, 'utf-8');
    
    expect(content).toContain('Docker Deployment');
    expect(content).toContain('docker build');
    expect(content).toContain('docker run');
  });
});

describe('G-3 Requirements Validation', () => {
  it('should validate all G-3 criteria are documented', () => {
    const docPath = join(__dirname, 'soak-g3.md');
    const content = readFileSync(docPath, 'utf-8');
    
    const g3Criteria = [
      '10,000 packs',
      '500 fusions',
      '100 risky',
      '200 wager matches',
      'abandoned pending',
      'stale pending',
      'crank p95',
      '20 seconds',
    ];
    
    for (const criterion of g3Criteria) {
      expect(content).toContain(criterion);
    }
  });

  it('should have implementation status markers', () => {
    const docPath = join(__dirname, 'soak-g3.md');
    const content = readFileSync(docPath, 'utf-8');
    
    expect(content).toContain('✅');
    expect(content).toContain('⚠️');
    expect(content).toContain('Implemented');
    expect(content).toContain('Placeholder');
  });
});
