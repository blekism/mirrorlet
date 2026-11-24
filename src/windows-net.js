'use strict';
// Windows-only network checks. AirPlay discovery fails silently in two
// common cases, so the app checks for both and offers a fix:
//   1. the Wi-Fi network is marked "Public" (Windows blocks local discovery)
//   2. there is no firewall rule letting uxplay.exe receive connections

const { execFile } = require('child_process');
const os = require('os');

const FIREWALL_RULE = 'Mirrorlet (UxPlay AirPlay receiver)';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

function localIPv4() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  return out;
}

async function networkProfiles() {
  if (process.platform !== 'win32') return [];
  const r = await powershell('Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress');
  if (r.code !== 0 || !r.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    // NetworkCategory serializes as a number: 0 = Public, 1 = Private, 2 = DomainAuthenticated
    const names = { 0: 'Public', 1: 'Private', 2: 'Domain' };
    return list.map((p) => ({
      name: p.Name,
      interfaceAlias: p.InterfaceAlias,
      category: typeof p.NetworkCategory === 'number' ? names[p.NetworkCategory] : String(p.NetworkCategory),
    }));
  } catch {
    return [];
  }
}

async function firewallRuleExists() {
  if (process.platform !== 'win32') return true;
  const r = await powershell(
    `if (Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }) { 'yes' } else { 'no' }`,
  );
  return r.stdout.trim() === 'yes';
}

// Adds the rule through an elevated netsh (Windows shows a UAC prompt).
async function addFirewallRule(exePath) {
  if (process.platform !== 'win32') return { ok: true };
  const q = (s) => s.replace(/'/g, "''");
  const netshArgs = [
    'advfirewall firewall delete rule', `name="${FIREWALL_RULE}"`, '&',
    'netsh advfirewall firewall add rule', `name="${FIREWALL_RULE}"`, 'dir=in', 'action=allow',
    `program="${exePath}"`, 'enable=yes', 'profile=private,domain',
  ].join(' ');
  const script = `Start-Process -FilePath cmd.exe -ArgumentList '/c netsh ${q(netshArgs)}' -Verb RunAs -WindowStyle Hidden -Wait`;
  const r = await powershell(script);
  const ok = await firewallRuleExists();
  return { ok, detail: ok ? '' : (r.stderr || 'The administrator prompt was cancelled.') };
}

async function diagnostics() {
  const [profiles, firewallOk] = await Promise.all([networkProfiles(), firewallRuleExists()]);
  return {
    ips: localIPv4(),
    profiles,
    publicNetwork: profiles.some((p) => p.category === 'Public'),
    firewallOk,
  };
}

module.exports = { diagnostics, addFirewallRule, firewallRuleExists, localIPv4, FIREWALL_RULE };
