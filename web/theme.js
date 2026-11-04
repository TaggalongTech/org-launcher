// Runs before the stylesheet so a saved light or dark theme is in place on the first paint. No choice: follow the system.
(() => {
  'use strict';
  try {
    const theme = localStorage.getItem('orgLauncher.theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch (e) { /* storage blocked: follow the system */ }
})();
