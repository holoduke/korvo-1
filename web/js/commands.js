/* Commands a device may miss: some integrations only log a failed write while
 * Home Assistant reports the service call as done. Each command shows as
 * pending until landed() reports its effect, is sent once more when it has not
 * landed in time, and is then reported.
 *   const queue = Panel.commandQueue(subject, changed)
 *   queue.send(key, {send() -> promise, landed(), wait (ms), failed})
 *     key is "group|what": a newer command of the same group replaces a
 *     pending one; failed says what did not happen ("zuigkracht is niet aangepast")
 *   queue.has(key)    still waiting for it
 *   queue.settle()    call on every render: resends or reports what ran out of time
 * changed() runs when a command's time runs out or its call fails (to redraw). */
(function () {
  "use strict";
  const Panel = window.Panel;
  const TRIES = 2;

  Panel.commandQueue = function (subject, changed) {
    const commands = new Map(); /* key -> {send, landed, wait, failed, tries} */
    const pending = Util.pendingSet(8000, changed);

    function send(key, def) {
      const group = key.split("|")[0];
      for (const other of [...commands.keys()]) {
        if (other !== key && other.split("|")[0] === group) {
          pending.drop(other);
          commands.delete(other);
        }
      }
      const c = { ...def, tries: ((commands.get(key) || {}).tries || 0) + 1 };
      commands.set(key, c);
      pending.mark(key, c.landed, c.wait);
      c.send().catch((err) => {
        pending.drop(key);
        commands.delete(key);
        changed();
        Panel.commandFailed(subject)(err);
      });
    }

    return {
      send,
      has: (key) => pending.has(key),
      settle() {
        for (const key of pending.settle()) {
          const c = commands.get(key);
          if (c.tries < TRIES) send(key, c);
          else Panel.toast(`${subject} reageerde niet: ${c.failed}`);
        }
        for (const key of [...commands.keys()]) if (!pending.has(key)) commands.delete(key);
      },
    };
  };
})();
