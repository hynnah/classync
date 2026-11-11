(function () {
  const checkbox = document.getElementById('age-confirm');
  const signInButton = document.getElementById('google-signin');
  const errorEl = document.getElementById('signin-error');
  const ageRow = checkbox.closest('.age-confirm');
  const ageHint = document.getElementById('age-confirm-hint');
  // Asked on every sign-in (auth.routes.js rejects /auth/google without it),
  // not just the first — the copy must not suggest otherwise.
  const AGE_HINT = 'Required to sign in';
  const AGE_HINT_MISSING = 'Tick this box to continue.';

  // The button stays clickable (aria-disabled, not disabled) so a click before
  // the box is ticked can say why nothing happened, instead of silently
  // swallowing it — a truly disabled button gives no feedback at all.
  checkbox.addEventListener('change', () => {
    signInButton.setAttribute('aria-disabled', String(!checkbox.checked));
    if (checkbox.checked) {
      ageRow.classList.remove('is-missing');
      ageHint.textContent = AGE_HINT;
    }
  });

  signInButton.addEventListener('click', () => {
    if (!checkbox.checked) {
      ageHint.textContent = AGE_HINT_MISSING;
      // Restart the nudge animation on every repeated click.
      ageRow.classList.remove('is-missing');
      void ageRow.offsetWidth;
      ageRow.classList.add('is-missing');
      checkbox.focus();
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const next = params.get('next');
    const target = new URLSearchParams({ ageConfirmed: 'true' });
    if (next) {
      target.set('next', next);
    }
    window.location.href = `/auth/google?${target.toString()}`;
  });

  const ERROR_MESSAGES = {
    deactivated: 'This account has been deactivated. If you think this is a mistake, contact an admin.',
    expired: 'That sign-in link expired or was already used. Please sign in again.',
    cancelled: 'Google sign-in was cancelled. Please try again.',
    failed: 'Sign-in failed. Please try again.',
  };

  const params = new URLSearchParams(window.location.search);
  const errorCode = params.get('error');
  if (errorCode) {
    errorEl.textContent = ERROR_MESSAGES[errorCode] || 'Sign-in was cancelled or failed. Please try again.';
    errorEl.hidden = false;
  }
})();
