# AGENTS.md

Notes for coding agents (Claude Code, Codex, ...) working in this repository.

## Project at a glance

- Agent Console is a local web panel for Claude Code / Codex sessions. Server: Fastify 5, Node 22+, ESM TypeScript.
  Panel: React 19 + Vite. Tests: vitest (`npm test`). Build: `npm run build` (writes `dist/`).
- The CLI is `dist/cli/main.js` (`agent-console` when installed with `npm install -g .`). `agent-console` with no
  arguments starts the server.
- Data directory: `~/.agent-console/` (override with `AGENT_CONSOLE_HOME`). It holds `config.json`, `token`,
  `auth.json`, `sessions.json` and `tls/`.
- Two entries share one server process:
  - local: `http://127.0.0.1:4317`, signed in with the token.
  - remote (optional): `https://<host>:4318`, signed in with a user name and password.
- User-facing documentation lives in `README.md` ("Remote access" section). Keep it in sync when behaviour changes.

## Remote access: verify the auto-generated self-signed certificate

Goal: confirm that a client computer trusts the certificate Agent Console creates by itself (no `certFile` /
`keyFile` configured) after it is imported into the client's "Trusted Root Certification Authorities" store, so Edge
and Chrome open the remote entry without a certificate warning.

Why this needs checking: the generated certificate is a self-signed server (leaf) certificate, not a CA certificate.
Details: EC P-256, `basicConstraints cA:false`, `extKeyUsage serverAuth`, SAN = `remote.hostnames`, valid 2 years.
The code is in `src/server/remote/tls.ts`. Windows normally accepts such a certificate as a trust anchor, but this has
not been tested with real browsers yet.

### Ground rules for the agent

- Two computers are involved: the **workstation** (runs Agent Console) and the **client** (opens the browser). You
  may only have access to one of them. Ask the user to do the steps on the other one and to paste back what they see.
- The user runs these steps themselves. Give them the exact command and wait for the result:
  - Firewall rules, and anything else that needs an elevated (administrator) shell.
  - Changes to a certificate store: importing into `Root`, or removing from it. Windows shows a security warning that
    the user must confirm.
  - `agent-console set-password`, which asks for a password the user types. Never type, choose, or log a password.
- Never read, print, copy or move these files: `key.pem`, `auth.json`, `sessions.json`, `token`. Only `cert.pem` ever
  leaves the workstation.
- Do not set `remote.certFile` / `remote.keyFile` for this check. That would switch off the auto-generated
  certificate being tested.

### Workstation steps

1. Find the name the client will use. Ask the user for the company-assigned DNS name, or show the candidates with:

   ```powershell
   [System.Net.Dns]::GetHostEntry('').HostName
   ```

2. Make sure a remote password exists. If `~/.agent-console/auth.json` is missing, ask the user to run
   `agent-console set-password`. Only check whether the file exists; do not read it.

3. Add or check the `remote` block in `~/.agent-console/config.json`. Keep the other keys, and do not add
   `certFile` / `keyFile`:

   ```json
   { "remote": { "enabled": true, "hostnames": ["<dns-name>"] } }
   ```

   Every name typed in the client's browser must be listed in `hostnames`. The certificate's SAN is built from this
   list.

4. Ask the user to allow the port, in an elevated PowerShell:

   ```powershell
   New-NetFirewallRule -DisplayName "Agent Console remote" -Direction Inbound -Protocol TCP -LocalPort 4318 -Action Allow
   ```

5. Start or restart `agent-console`, then note the startup lines:
   - `Remote access certificate: <path>\tls\cert.pem (SHA-256 AB:CD:...)`: record the SHA-256 fingerprint.
   - `Remote access: https://<dns-name>:4318/`: this is the address to open.
   - `A new self-signed certificate was created; ...` appears when the certificate was just (re)generated.
   - `Remote access is off: <reason>` means the remote entry did not start. Fix the reason first.

6. Optionally confirm the SAN and fingerprint from the file. `cert.pem` is public, so reading it is fine:

   ```bash
   node -e "const x=new (require('crypto').X509Certificate)(require('fs').readFileSync(process.argv[1]));console.log(x.subjectAltName);console.log(x.fingerprint256);console.log(x.validTo)" "$HOME/.agent-console/tls/cert.pem"
   ```

7. Copy `cert.pem` (only that file) to the client, for example over a share or USB stick.

### Client steps

1. Check that the copied file is the same certificate. In PowerShell 7, this prints the SHA-256 fingerprint without
   colons; compare it with the one recorded in workstation step 5:

   ```powershell
   [System.Security.Cryptography.X509Certificates.X509Certificate2]::new("$PWD\cert.pem").GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)
   ```

   Windows PowerShell 5.1 lacks that overload. Compare the fingerprint in the browser's certificate viewer instead
   (step 4).

2. Ask the user to import it for their own account:

   ```powershell
   Import-Certificate -FilePath .\cert.pem -CertStoreLocation Cert:\CurrentUser\Root
   ```

   If `Import-Certificate` rejects the `.pem` extension, rename the file to `cert.crt`, or use:

   ```powershell
   certutil -user -addstore Root .\cert.pem
   ```

3. Close **every** Edge and Chrome window, so the browsers reload the certificate store. Then open
   `https://<dns-name>:4318/` in each browser.

4. In each browser, open the padlock, then the certificate details. Confirm the SHA-256 fingerprint matches.

### Reading the result

| What the browser shows | Meaning | Next step |
| --- | --- | --- |
| Agent Console sign-in screen, padlock, no warning | **PASS**: the auto-generated certificate is trusted | Record browser names and versions; done |
| `NET::ERR_CERT_AUTHORITY_INVALID` | **FAIL**: the browser does not accept the self-signed leaf as a trust anchor | Confirm the import landed in `CurrentUser\Root` and the browsers were fully restarted; if it still fails, report it (see fallback below) |
| `NET::ERR_CERT_COMMON_NAME_INVALID` | The typed name is not in the certificate's SAN | Add the name to `remote.hostnames`, restart (a new certificate is created), and import the new `cert.pem` again |
| A plain `403` response | The `Host` header is not in `remote.hostnames` | Same as the row above |
| Connection timed out / refused | Network or firewall, not the certificate | Check the firewall rule, `remote.bindHost`, and that the server is running |

Firefox uses its own certificate store and ignores the Windows one, unless `security.enterprise_roots.enabled` is
`true`. Test Edge and Chrome; Firefox is optional.

To inspect the store, use the commands below. They list or remove one certificate by its SHA-1 thumbprint. The user
runs the removal.

```powershell
Get-ChildItem Cert:\CurrentUser\Root | Where-Object Subject -like "*<dns-name>*" | Format-List Subject, Thumbprint, NotAfter
Get-ChildItem Cert:\CurrentUser\Root\<THUMBPRINT> | Remove-Item
```

### Fallback if the check fails

Do not change `src/server/remote/tls.ts` during the check. Report the browser, its version, and the exact error to the
user. The known alternatives are:

- Click through the warning once, after comparing the SHA-256 fingerprint with the startup line. This is supported
  today.
- Create a small local CA and sign a server certificate with it. Point `remote.certFile` / `remote.keyFile` at the
  result, and import the CA's certificate on clients instead.
- Change the generator so that it creates a local CA plus a server certificate. This is a code change and needs the
  user's go-ahead.

### Things that make the client trust it again

The certificate is regenerated, and every client must import the new `cert.pem`, when any of these happens:

- Fewer than 30 days of validity remain at startup.
- `remote.hostnames` changes.
- The files in `~/.agent-console/tls/` are missing or unusable.

The startup line `A new self-signed certificate was created` signals this.
