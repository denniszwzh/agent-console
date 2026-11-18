import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api.js';

interface Props {
  /** Called once the server accepted the credentials (the session cookie is set). */
  onSignedIn(): void;
}

/** Password sign-in for the external entry. Submits with fetch; there is no form action. */
export function Login({ onSignedIn }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.login(username, password);
      setPassword('');
      onSignedIn();
    } catch (err) {
      // 401 and 429 carry the server's own wording (the 429 text says how many minutes to wait).
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="login">
      <h1>Sign in</h1>
      <form onSubmit={(e) => void submit(e)}>
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <label>
          Username
          <input type="text" name="username" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit" className="btn primary" disabled={submitting}>
          Sign in
        </button>
      </form>
    </div>
  );
}
