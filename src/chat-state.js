/** Drafts are local to a conversation; storage failures still leave an in-memory copy. */
export class DraftStore {
  constructor(storage = () => globalThis.localStorage) {
    this.storage = storage;
    this.drafts = new Map();
    this.pending = new Set();
    this.timer = null;
  }
  get(cid) {
    if (!this.drafts.has(cid)) {
      let value = '';
      try { value = this.storage().getItem('aistation-draft-' + cid) || ''; } catch {}
      this.drafts.set(cid, {value, revision: 0});
    }
    return this.drafts.get(cid).value;
  }
  set(cid, value) {
    if (!cid) return;
    this.get(cid);
    const previous = this.drafts.get(cid);
    if (previous.value === value) return;
    this.drafts.set(cid, {value, revision: previous.revision + 1});
    this.pending.add(cid);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
  snapshot(cid) {
    this.get(cid);
    return {...this.drafts.get(cid)};
  }
  clearSubmitted(cid, snapshot) {
    const current = this.snapshot(cid);
    if (current.revision !== snapshot.revision || current.value !== snapshot.value) return false;
    this.set(cid, '');
    this.flush();
    return true;
  }
  remove(cid) {
    this.drafts.delete(cid);
    this.pending.delete(cid);
    try { this.storage().removeItem('aistation-draft-' + cid); } catch {}
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const cid of this.pending) {
      try {
        const value = this.drafts.get(cid)?.value || '';
        if (value) this.storage().setItem('aistation-draft-' + cid, value);
        else this.storage().removeItem('aistation-draft-' + cid);
      } catch {}
    }
    this.pending.clear();
  }
}

/** Both the signal and sequence guard are needed if a late response ignores abort. */
export class LatestRequest {
  constructor() { this.sequence = 0; this.controller = null; }
  cancel() {
    this.sequence++;
    this.controller?.abort();
    this.controller = null;
  }
  start(key) {
    this.cancel();
    this.controller = new AbortController();
    return {key, sequence: this.sequence, signal: this.controller.signal};
  }
  isCurrent(ticket) { return ticket.sequence === this.sequence && !ticket.signal.aborted; }
}
