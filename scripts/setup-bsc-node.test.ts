import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * scripts/setup-bsc-node.sh runs as root on a fresh server, downloads and
 * executes third-party code, opens a firewall port and formats disks. It is
 * NEVER executed here: these are static assertions over its text, plus
 * `bash -n`, which parses the file without running any of it.
 */
const SCRIPT_PATH = new URL('./setup-bsc-node.sh', import.meta.url)
const src = readFileSync(SCRIPT_PATH, 'utf8')

/** Source with comment-only lines removed, so prose can't satisfy or trip an assertion. */
const code = src
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

/** The ExecStart block of the generated systemd unit. */
const execStart = code.slice(code.indexOf('ExecStart='), code.indexOf('StandardOutput=journal'))

describe('setup-bsc-node.sh', () => {
  it('is syntactically valid bash (parse only, nothing is run)', () => {
    const res = spawnSync('bash', ['-n', fileURLToPath(SCRIPT_PATH)], { encoding: 'utf8' })
    expect(res.stderr).toBe('')
    expect(res.status).toBe(0)
  })

  describe('RPC exposure', () => {
    it('binds HTTP RPC to loopback by default, with the bind address as the only opt-in', () => {
      expect(code).toContain('RPC_BIND_ADDR="${RPC_BIND_ADDR:-127.0.0.1}"')
      expect(execStart).toContain('--http.addr $RPC_BIND_ADDR')
      expect(src).not.toContain('0.0.0.0')
    })

    it('serves only eth,net,web3 — never debug or txpool', () => {
      const api = execStart.match(/--http\.api (\S+)/)?.[1]
      expect(api).toBe('eth,net,web3')
      expect(execStart).not.toMatch(/debug|txpool/)
    })

    it('has no wildcard Host allow-list and no CORS', () => {
      expect(execStart).not.toMatch(/--http\.vhosts\s+"?\*/)
      expect(execStart).not.toContain('--http.corsdomain')
      expect(execStart).toContain('--http.vhosts localhost')
    })

    it('exits instead of opening the RPC port to everyone when RENDER_IPS is empty', () => {
      // A non-loopback bind with an empty allow-list must be an error...
      expect(code).toMatch(/\[\[ -n "\$RENDER_IPS" \]\]\s*\\\s*\|\| error/)
      // ...and the old unconditional "allow RPC from anywhere" rule must be gone.
      expect(code).not.toMatch(/ufw allow \$?\{?RPC_PORT\}?\/tcp/)
      for (const line of code.split('\n').filter((l) => /ufw allow.*RPC_PORT/.test(l))) {
        expect(line).toMatch(/ufw allow from /)
      }
    })
  })

  describe('supply chain', () => {
    it('never resolves "latest" or a moving branch', () => {
      expect(code).not.toContain('releases/latest')
      expect(code).not.toContain('api.github.com')
      expect(code).not.toMatch(/bsc-snapshots\/main\//)
      expect(code).toContain('releases/download/$BSC_VERSION')
      expect(code).toContain('bsc-snapshots/$FETCH_SNAPSHOT_COMMIT/dist/fetch-snapshot.sh')
    })

    it('refuses to run until every pin is set, before the first change to the machine', () => {
      const guard = code.indexOf('is not set. Pin it explicitly')
      expect(guard).toBeGreaterThan(-1)
      expect(guard).toBeLessThan(code.indexOf('step "1/9'))
      for (const pin of [
        'BSC_VERSION',
        'GETH_SHA256',
        'MAINNET_ZIP_SHA256',
        'FETCH_SNAPSHOT_COMMIT',
        'FETCH_SNAPSHOT_SHA256',
      ]) {
        // Declared with an EMPTY default (so unset means refuse), and checked.
        expect(code).toContain(`${pin}="\${${pin}:-}"`)
        expect(code).toMatch(new RegExp(`for var in [^\\n]*\\b${pin}\\b`))
      }
    })

    it('verifies each artifact against its pinned sha256 before using it', () => {
      expect(code).toContain('sha256sum')
      const at = (s: string) => {
        const i = code.indexOf(s)
        expect(i, s).toBeGreaterThan(-1)
        return i
      }
      expect(at('verify_sha256 geth "$GETH_SHA256"')).toBeLessThan(at('chmod +x geth'))
      expect(at('verify_sha256 mainnet.zip "$MAINNET_ZIP_SHA256"')).toBeLessThan(at('unzip -o mainnet.zip'))
      expect(at('verify_sha256 "$SNAP_DIR/fetch-snapshot.sh" "$FETCH_SNAPSHOT_SHA256"')).toBeLessThan(
        at('chmod +x "$SNAP_DIR/fetch-snapshot.sh"'),
      )
    })

    it('runs downloaded code as the node user, not root', () => {
      // The downloaded fetch-snapshot.sh and the geth binary are never run bare.
      expect(code).toMatch(/^sudo -u \$BSC_USER bash fetch-snapshot\.sh/m)
      expect(code).not.toMatch(/^bash fetch-snapshot\.sh/m)
      expect(code).toContain('sudo -u "$BSC_USER" ./geth version')
      expect(code).toContain('sudo -u "$BSC_USER" unzip')
      // The root-run wrapper must not live somewhere the node user can rewrite.
      expect(code).toContain('chown root:root "$RUN_SNAPSHOT"')
      expect(code).not.toContain('/home/$BSC_USER/run-snapshot.sh')
    })
  })

  describe('destructive disk step', () => {
    it('requires CONFIRM_WIPE=yes before any mdadm/mkfs', () => {
      const guard = code.indexOf('"$CONFIRM_WIPE" != "yes"')
      expect(guard).toBeGreaterThan(-1)
      expect(guard).toBeLessThan(code.indexOf('mdadm --create'))
      expect(guard).toBeLessThan(code.indexOf('mkfs.ext4'))
      // Every mkfs.ext4 / mdadm --create comes after the guard, not just the first.
      for (const m of code.matchAll(/mkfs\.ext4|mdadm --create/g)) {
        expect(m.index).toBeGreaterThan(guard)
      }
    })

    it('does not default the confirmation to yes', () => {
      expect(code).toContain('CONFIRM_WIPE="${CONFIRM_WIPE:-}"')
    })

    it('refuses to wipe a drive that is mounted or in use', () => {
      expect(code).toMatch(/lsblk -nr -o MOUNTPOINT "\$dev"/)
      expect(code).toContain('refusing to wipe it')
    })
  })
})
