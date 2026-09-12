(function () {
  const checkbox = document.getElementById('age-confirm');
  const signInButton = document.getElementById('google-signin');
  const errorEl = document.getElementById('signin-error');

  checkbox.addEventListener('change', () => {
    signInButton.disabled = !checkbox.checked;
  });

  signInButton.addEventListener('click', () => {
    if (!checkbox.checked) {
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
