export function createStore(initialState, renderFn) {
  let state = { ...initialState };

  function render() {
    renderFn(state, setState);
  }

  function setState(patch) {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    render();
  }

  render();
  return { getState: () => state, setState };
}
