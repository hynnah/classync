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

  const params = new URLSearchParams(window.location.search);
  if (params.get('error')) {
    errorEl.textContent = 'Sign-in was cancelled or failed. Please try again.';
    errorEl.hidden = false;
  }
})();
