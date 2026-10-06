// Tiny IndexedDB key/value store used for autosave (images are too big for localStorage).
(function () {
  'use strict';
  var DB = 'ponytiler', STORE = 'kv', dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
      var req = indexedDB.open(DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var req = fn(t.objectStore(STORE));
        t.oncomplete = function () { resolve(req && req.result); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  window.Store = {
    get: function (key) { return tx('readonly', function (s) { return s.get(key); }); },
    set: function (key, val) { return tx('readwrite', function (s) { return s.put(val, key); }); },
    del: function (key) { return tx('readwrite', function (s) { return s.delete(key); }); }
  };
})();
