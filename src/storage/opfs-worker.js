// OPFS write worker — Safari path: createSyncAccessHandle is worker-only.
self.onmessage = async (e) => {
  const { id, name, bytes } = e.data;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("projects", { create: true });
    const handle = await dir.getFileHandle(name, { create: true });
    const access = await handle.createSyncAccessHandle();
    try {
      access.truncate(0);
      access.write(new Uint8Array(bytes), { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
    self.postMessage({ id });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
