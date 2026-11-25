(function (global) {
  'use strict';

  const IDB_NAME = 'imd_quest_db';
  const IDB_VERSION = 1;
  const ACTIVE_FALLBACK_KEY = 'imd_quest_active_session_v1';

  function localDayKey(isoOrDate) {
    const d = isoOrDate ? new Date(isoOrDate) : new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function makeClientUid(sess) {
    if (sess.clientUid) return String(sess.clientUid);
    return `${sess.date || ''}|${sess.mode || ''}|${sess.total || 0}|${sess.correct || 0}|${sess.elapsedSec || 0}`;
  }

  function openIDB() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error('IndexedDB indisponível'));
        return;
      }
      const req = global.indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains('sessions')) {
          const store = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
          store.createIndex('date', 'date', { unique: false });
          store.createIndex('mode', 'mode', { unique: false });
          store.createIndex('clientUid', 'clientUid', { unique: false });
        }
        if (!db.objectStoreNames.contains('question_stats')) {
          db.createObjectStore('question_stats', { keyPath: 'qId' });
        }
        if (!db.objectStoreNames.contains('daily_activity')) {
          db.createObjectStore('daily_activity', { keyPath: 'day' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Falha ao abrir IndexedDB'));
    });
  }

  function idbReq(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbTxDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transação abortada'));
    });
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  const IMDQuestDB = {
    db: null,
    engine: 'indexeddb',
    ready: false,

    async init(legacyStats) {
      try {
        this.db = await openIDB();
      } catch (e) {
        this.db = null;
      }

      if (this.db) {
        await this._migrateLegacyIfNeeded(legacyStats);
      }

      // Detectar servidor Python SQLite quando servido via HTTP
      if (global.location && global.location.protocol && global.location.protocol.startsWith('http')) {
        try {
          const res = await fetchWithTimeout('/api/health', {}, 1200);
          if (res.ok) {
            const info = await res.json();
            if (info && info.ok) {
              this.engine = 'sqlite';
              await this._syncWithServer();
            }
          }
        } catch (e) {
          this.engine = this.db ? 'indexeddb' : 'localstorage';
        }
      } else if (!this.db) {
        this.engine = 'localstorage';
      }

      this.ready = true;
      return this.engine;
    },

    async _getMeta(key) {
      if (!this.db) return null;
      const tx = this.db.transaction('meta', 'readonly');
      const row = await idbReq(tx.objectStore('meta').get(key));
      return row ? row.value : null;
    },

    async _setMeta(key, value) {
      if (!this.db) return;
      const tx = this.db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key, value });
      await idbTxDone(tx);
    },

    async _deleteMeta(key) {
      if (!this.db) return;
      const tx = this.db.transaction('meta', 'readwrite');
      tx.objectStore('meta').delete(key);
      await idbTxDone(tx);
    },

    async _getAll(storeName) {
      if (!this.db) return [];
      const tx = this.db.transaction(storeName, 'readonly');
      return await idbReq(tx.objectStore(storeName).getAll());
    },

    async _migrateLegacyIfNeeded(legacyStats) {
      const migrated = await this._getMeta('migrated_v1');
      if (migrated) return;

      const existingSessions = await this._getAll('sessions');
      const existingQStats = await this._getAll('question_stats');

      if (
        existingSessions.length === 0 &&
        existingQStats.length === 0 &&
        legacyStats &&
        ((legacyStats.history && legacyStats.history.length > 0) ||
          (legacyStats.seenIds && legacyStats.seenIds.length > 0))
      ) {
        const tx = this.db.transaction(['sessions', 'question_stats', 'daily_activity'], 'readwrite');
        const sessStore = tx.objectStore('sessions');
        const qStore = tx.objectStore('question_stats');
        const dStore = tx.objectStore('daily_activity');

        const dailyMap = {};
        const hist = Array.isArray(legacyStats.history) ? legacyStats.history : [];
        // Inserir do mais antigo para o mais novo
        for (let i = hist.length - 1; i >= 0; i--) {
          const h = hist[i];
          const total = Number(h.total || 0);
          const correct = Number(h.correct || 0);
          const rec = {
            clientUid: makeClientUid(h),
            date: h.date || new Date().toISOString(),
            localDay: localDayKey(h.date),
            mode: h.mode || 'explicado',
            orderMode: h.orderMode || 'segmentado',
            label: h.label || null,
            total,
            correct,
            score: Number(h.score || 0),
            accuracy: total > 0 ? Number(((correct / total) * 100).toFixed(1)) : 0,
            elapsedSec: Number(h.elapsedSec || 0),
            bySubject: h.bySubject || {},
            byDifficulty: h.byDifficulty || {},
            byLesson: h.byLesson || {},
            items: Array.isArray(h.items) ? h.items : []
          };
          sessStore.add(rec);

          const dk = rec.localDay;
          if (!dailyMap[dk]) dailyMap[dk] = { day: dk, sessions: 0, answered: 0, correct: 0, elapsedSec: 0 };
          dailyMap[dk].sessions++;
          dailyMap[dk].answered += total;
          dailyMap[dk].correct += correct;
          dailyMap[dk].elapsedSec += rec.elapsedSec;
        }

        for (const d of Object.values(dailyMap)) {
          dStore.put(d);
        }

        const wrongSet = new Set(legacyStats.wrongIds || []);
        const seenSet = new Set([...(legacyStats.seenIds || []), ...(legacyStats.wrongIds || [])]);
        const bankMap = {};
        if (Array.isArray(global.QUESTION_BANK)) {
          for (const q of global.QUESTION_BANK) bankMap[q.id] = q;
        }
        for (const qId of seenSet) {
          const q = bankMap[qId] || {};
          const isWrong = wrongSet.has(qId);
          qStore.put({
            qId,
            subject: q.subject || '',
            lesson: q.lesson || '',
            lessonNum: q.lessonNum || null,
            difficulty: q.difficulty || 'medio',
            seenCount: 1,
            correctCount: isWrong ? 0 : 1,
            wrongCount: isWrong ? 1 : 0,
            streak: isWrong ? 0 : 1,
            lastResult: isWrong ? 0 : 1,
            lastAnsweredAt: null
          });
        }

        await idbTxDone(tx);
      }

      await this._setMeta('migrated_v1', true);
    },

    async _syncWithServer() {
      try {
        const res = await fetchWithTimeout('/api/stats', {}, 2500);
        if (!res.ok) return;
        const remote = await res.json();
        const localSessions = await this._getAll('sessions');

        // Se o servidor estiver vazio mas o navegador já tiver histórico local, sobe para o SQLite
        if ((!remote.history || remote.history.length === 0) && localSessions.length > 0) {
          const qStats = await this._getAll('question_stats');
          const daily = await this._getAll('daily_activity');
          await fetchWithTimeout(
            '/api/import',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessions: localSessions,
                questionStats: qStats,
                dailyActivity: daily
              })
            },
            4000
          );
          return;
        }

        // Caso contrário, se o servidor tiver sessões que o navegador não tem, hidrata o IndexedDB
        if (remote.history && remote.history.length > 0 && this.db) {
          const existingUids = new Set(localSessions.map((s) => s.clientUid || makeClientUid(s)));
          const tx = this.db.transaction(['sessions', 'question_stats', 'daily_activity'], 'readwrite');
          const sessStore = tx.objectStore('sessions');
          const qStore = tx.objectStore('question_stats');
          const dStore = tx.objectStore('daily_activity');

          for (let i = remote.history.length - 1; i >= 0; i--) {
            const rs = remote.history[i];
            const uid = rs.clientUid || makeClientUid(rs);
            if (!existingUids.has(uid)) {
              sessStore.add({
                clientUid: uid,
                date: rs.date,
                localDay: localDayKey(rs.date),
                mode: rs.mode,
                orderMode: rs.orderMode,
                label: rs.label || null,
                total: rs.total,
                correct: rs.correct,
                score: rs.score,
                accuracy: rs.accuracy,
                elapsedSec: rs.elapsedSec,
                bySubject: rs.bySubject || {},
                byDifficulty: rs.byDifficulty || {},
                byLesson: rs.byLesson || {},
                items: rs.items || []
              });
              existingUids.add(uid);
            }
          }
          for (const qs of remote.questionStats || []) {
            qStore.put(qs);
          }
          for (const d of remote.dailyActivity || []) {
            dStore.put(d);
          }
          await idbTxDone(tx);
        }
      } catch (e) {
        // Falha de rede silenciosa: mantém IndexedDB
      }
    },

    async recordSession(sessionRecord) {
      const uid = makeClientUid(sessionRecord);
      const dayKey = localDayKey(sessionRecord.date);
      const rec = Object.assign({}, sessionRecord, {
        clientUid: uid,
        localDay: dayKey
      });

      if (this.db) {
        const tx = this.db.transaction(['sessions', 'question_stats', 'daily_activity', 'meta'], 'readwrite');
        const sessStore = tx.objectStore('sessions');
        const qStore = tx.objectStore('question_stats');
        const dStore = tx.objectStore('daily_activity');

        sessStore.add(rec);

        for (const item of rec.items || []) {
          const prev = await idbReq(qStore.get(item.qId));
          const isOk = item.isCorrect ? 1 : 0;
          if (prev) {
            qStore.put({
              qId: item.qId,
              subject: item.subject,
              lesson: item.lesson,
              lessonNum: item.lessonNum ?? null,
              difficulty: item.difficulty || 'medio',
              seenCount: (prev.seenCount || 0) + 1,
              correctCount: (prev.correctCount || 0) + isOk,
              wrongCount: (prev.wrongCount || 0) + (isOk ? 0 : 1),
              streak: isOk ? (prev.streak || 0) + 1 : 0,
              lastResult: isOk,
              lastAnsweredAt: rec.date
            });
          } else {
            qStore.put({
              qId: item.qId,
              subject: item.subject,
              lesson: item.lesson,
              lessonNum: item.lessonNum ?? null,
              difficulty: item.difficulty || 'medio',
              seenCount: 1,
              correctCount: isOk,
              wrongCount: isOk ? 0 : 1,
              streak: isOk ? 1 : 0,
              lastResult: isOk,
              lastAnsweredAt: rec.date
            });
          }
        }

        const prevDay = await idbReq(dStore.get(dayKey));
        if (prevDay) {
          dStore.put({
            day: dayKey,
            sessions: (prevDay.sessions || 0) + 1,
            answered: (prevDay.answered || 0) + Number(rec.total || 0),
            correct: (prevDay.correct || 0) + Number(rec.correct || 0),
            elapsedSec: (prevDay.elapsedSec || 0) + Number(rec.elapsedSec || 0)
          });
        } else {
          dStore.put({
            day: dayKey,
            sessions: 1,
            answered: Number(rec.total || 0),
            correct: Number(rec.correct || 0),
            elapsedSec: Number(rec.elapsedSec || 0)
          });
        }

        tx.objectStore('meta').delete('active_session');
        await idbTxDone(tx);
      }

      try {
        localStorage.removeItem(ACTIVE_FALLBACK_KEY);
      } catch (e) {}

      if (this.engine === 'sqlite') {
        try {
          await fetchWithTimeout(
            '/api/sessions',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(rec)
            },
            3000
          );
        } catch (e) {}
      }
    },

    async saveActiveSession(payload) {
      try {
        localStorage.setItem(ACTIVE_FALLBACK_KEY, JSON.stringify(payload));
      } catch (e) {}

      if (this.db) {
        try {
          await this._setMeta('active_session', payload);
        } catch (e) {}
      }

      if (this.engine === 'sqlite') {
        try {
          await fetchWithTimeout(
            '/api/active-session',
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            },
            1500
          );
        } catch (e) {}
      }
    },

    async getActiveSession() {
      let localActive = null;
      if (this.db) {
        try {
          localActive = await this._getMeta('active_session');
        } catch (e) {}
      }
      if (!localActive) {
        try {
          const raw = localStorage.getItem(ACTIVE_FALLBACK_KEY);
          if (raw) localActive = JSON.parse(raw);
        } catch (e) {}
      }
      if (!localActive && this.engine === 'sqlite') {
        try {
          const res = await fetchWithTimeout('/api/stats', {}, 1500);
          if (res.ok) {
            const data = await res.json();
            if (data.activeSession) localActive = data.activeSession;
          }
        } catch (e) {}
      }
      return localActive;
    },

    async clearActiveSession() {
      try {
        localStorage.removeItem(ACTIVE_FALLBACK_KEY);
      } catch (e) {}
      if (this.db) {
        try {
          await this._deleteMeta('active_session');
        } catch (e) {}
      }
      if (this.engine === 'sqlite') {
        try {
          await fetchWithTimeout('/api/active-session', { method: 'DELETE' }, 1500);
        } catch (e) {}
      }
    },

    async buildLegacyStatsSync() {
      const sessions = (await this._getAll('sessions')).sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      );
      const qStats = await this._getAll('question_stats');

      const wrongIds = [];
      const seenIds = [];
      for (const q of qStats) {
        seenIds.push(q.qId);
        if (q.lastResult === 0) wrongIds.push(q.qId);
      }

      const bySubject = {};
      for (const s of sessions) {
        const bs = s.bySubject || {};
        for (const [subId, val] of Object.entries(bs)) {
          if (!bySubject[subId]) bySubject[subId] = { correct: 0, total: 0 };
          bySubject[subId].correct += Number(val.correct || 0);
          bySubject[subId].total += Number(val.total || 0);
        }
      }

      return {
        history: sessions,
        wrongIds,
        seenIds,
        bySubject
      };
    },

    async getAnalytics() {
      const sessions = (await this._getAll('sessions')).sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      );
      const qStats = await this._getAll('question_stats');
      const dailyActivity = (await this._getAll('daily_activity')).sort((a, b) =>
        a.day.localeCompare(b.day)
      );

      let totalAnswered = 0;
      let totalCorrect = 0;
      let totalElapsed = 0;
      const byDifficulty = {
        facil: { correct: 0, total: 0 },
        medio: { correct: 0, total: 0 },
        dificil: { correct: 0, total: 0 }
      };

      for (const s of sessions) {
        totalAnswered += Number(s.total || 0);
        totalCorrect += Number(s.correct || 0);
        totalElapsed += Number(s.elapsedSec || 0);

        const bd = s.byDifficulty || {};
        for (const diff of ['facil', 'medio', 'dificil']) {
          if (bd[diff]) {
            byDifficulty[diff].correct += Number(bd[diff].correct || 0);
            byDifficulty[diff].total += Number(bd[diff].total || 0);
          }
        }
      }

      // Se sessões antigas não tinham byDifficulty, completar via question_stats
      const diffSum =
        byDifficulty.facil.total + byDifficulty.medio.total + byDifficulty.dificil.total;
      if (diffSum === 0 && qStats.length > 0) {
        for (const q of qStats) {
          const d = byDifficulty[q.difficulty] ? q.difficulty : 'medio';
          byDifficulty[d].total += Number(q.seenCount || 0);
          byDifficulty[d].correct += Number(q.correctCount || 0);
        }
      }

      const overallAccuracy =
        totalAnswered > 0 ? Number(((totalCorrect / totalAnswered) * 100).toFixed(1)) : 0;
      const avgTimePerQuestionSec =
        totalAnswered > 0 ? Math.round(totalElapsed / totalAnswered) : 0;

      // Ofensiva (streak de dias consecutivos até hoje ou ontem)
      const daySet = new Set(dailyActivity.filter((d) => d.sessions > 0).map((d) => d.day));
      let streakDays = 0;
      if (daySet.size > 0) {
        const cursor = new Date();
        let key = localDayKey(cursor);
        if (!daySet.has(key)) {
          cursor.setDate(cursor.getDate() - 1);
          key = localDayKey(cursor);
        }
        while (daySet.has(key)) {
          streakDays++;
          cursor.setDate(cursor.getDate() - 1);
          key = localDayKey(cursor);
        }
      }

      // Aulas com menor assertividade (a partir de question_stats com histórico real)
      const lessonMap = {};
      for (const q of qStats) {
        if (!q.lesson || !q.seenCount) continue;
        const k = `${q.subject}::${q.lesson}`;
        if (!lessonMap[k]) {
          lessonMap[k] = {
            subject: q.subject,
            lesson: q.lesson,
            lessonNum: q.lessonNum,
            seen: 0,
            correct: 0,
            qIds: []
          };
        }
        lessonMap[k].seen += Number(q.seenCount || 0);
        lessonMap[k].correct += Number(q.correctCount || 0);
        if (q.lastResult === 0 || (q.wrongCount || 0) > 0) {
          lessonMap[k].qIds.push(q.qId);
        }
      }

      const weakLessons = Object.values(lessonMap)
        .filter((l) => l.seen > 0)
        .map((l) =>
          Object.assign({}, l, {
            accuracy: Math.round((l.correct / l.seen) * 100)
          })
        )
        .sort((a, b) => a.accuracy - b.accuracy || b.seen - a.seen)
        .slice(0, 5);

      return {
        sessions,
        questionStats: qStats,
        dailyActivity,
        totalAnswered,
        totalCorrect,
        totalElapsed,
        overallAccuracy,
        avgTimePerQuestionSec,
        streakDays,
        byDifficulty,
        weakLessons
      };
    },

    async clearAll() {
      if (this.db) {
        const tx = this.db.transaction(
          ['sessions', 'question_stats', 'daily_activity', 'meta'],
          'readwrite'
        );
        tx.objectStore('sessions').clear();
        tx.objectStore('question_stats').clear();
        tx.objectStore('daily_activity').clear();
        tx.objectStore('meta').delete('active_session');
        await idbTxDone(tx);
      }
      try {
        localStorage.removeItem(ACTIVE_FALLBACK_KEY);
      } catch (e) {}

      if (this.engine === 'sqlite') {
        try {
          await fetchWithTimeout('/api/stats', { method: 'DELETE' }, 2500);
        } catch (e) {}
      }
    },

    async exportJSON() {
      let payload = null;
      if (this.engine === 'sqlite') {
        try {
          const res = await fetchWithTimeout('/api/export', {}, 3000);
          if (res.ok) payload = await res.json();
        } catch (e) {}
      }
      if (!payload) {
        const sessions = await this._getAll('sessions');
        const questionStats = await this._getAll('question_stats');
        const dailyActivity = await this._getAll('daily_activity');
        payload = {
          app: 'IMD Quest',
          version: 1,
          exportedAt: new Date().toISOString(),
          sessions,
          questionStats,
          dailyActivity
        };
      }

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `imd_quest_backup_${localDayKey()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return payload;
    },

    async exportCSV() {
      const sessions = (await this._getAll('sessions')).sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      );
      const headers = ['Data', 'Modelo', 'Ordem', 'Questoes', 'Acertos', 'Assertividade(%)', 'Nota', 'Tempo(s)', 'Rotulo'];
      const rows = [headers.join(';')];
      for (const s of sessions) {
        const total = Number(s.total || 0);
        const correct = Number(s.correct || 0);
        const acc = s.accuracy ?? (total > 0 ? ((correct / total) * 100).toFixed(1) : '0');
        const cols = [
          s.date || '',
          s.mode || '',
          s.orderMode || '',
          total,
          correct,
          String(acc).replace('.', ','),
          String(Number(s.score || 0).toFixed(1)).replace('.', ','),
          Number(s.elapsedSec || 0),
          `"${String(s.label || '').replace(/"/g, '""')}"`
        ];
        rows.push(cols.join(';'));
      }
      const csv = '\uFEFF' + rows.join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `imd_quest_relatorio_${localDayKey()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },

    async importJSON(parsed) {
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Arquivo JSON inválido.');
      }
      const sessions = Array.isArray(parsed.sessions)
        ? parsed.sessions
        : Array.isArray(parsed.history)
        ? parsed.history
        : [];
      const qStats = Array.isArray(parsed.questionStats) ? parsed.questionStats : [];
      const daily = Array.isArray(parsed.dailyActivity) ? parsed.dailyActivity : [];

      if (sessions.length === 0 && qStats.length === 0) {
        throw new Error('Nenhum dado de simulado encontrado no arquivo.');
      }

      let importedCount = 0;
      if (this.db) {
        const existing = await this._getAll('sessions');
        const existingUids = new Set(existing.map((s) => s.clientUid || makeClientUid(s)));
        const tx = this.db.transaction(['sessions', 'question_stats', 'daily_activity'], 'readwrite');
        const sStore = tx.objectStore('sessions');
        const qStore = tx.objectStore('question_stats');
        const dStore = tx.objectStore('daily_activity');

        for (const s of sessions) {
          const uid = s.clientUid || makeClientUid(s);
          if (!existingUids.has(uid)) {
            const copy = Object.assign({}, s, { clientUid: uid, localDay: s.localDay || localDayKey(s.date) });
            delete copy.id;
            sStore.add(copy);
            existingUids.add(uid);
            importedCount++;
          }
        }
        for (const q of qStats) {
          if (q.qId) qStore.put(q);
        }
        for (const d of daily) {
          if (d.day) dStore.put(d);
        }
        await idbTxDone(tx);
      }

      if (this.engine === 'sqlite') {
        await fetchWithTimeout(
          '/api/import',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessions, questionStats: qStats, dailyActivity: daily })
          },
          4000
        );
      }

      return importedCount;
    }
  };

  global.IMDQuestDB = IMDQuestDB;
})(window);
