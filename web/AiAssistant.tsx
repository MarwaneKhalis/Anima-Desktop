import { useEffect, useRef, useState, type FormEvent } from 'react';
import './ai-assistant.css';

export type AiAssistantRequest = (path: string, method?: string, body?: unknown) => Promise<unknown>;
export interface AiAssistantApplication { id: string; title: string; company: string; }

export interface AiAssistantProps {
  /** Use the host workspace API helper so browser and Electron requests share the same transport. */
  request: AiAssistantRequest;
  /** Selected application, used for both generation and clearly labeling the opt-in. */
  selectedApplication?: AiAssistantApplication;
  view?: "connection" | "application";
}

interface AiSettings { baseUrl: string; model: string; updatedAt: string; }
interface AiConfigResponse { configured: boolean; settings: AiSettings | null; vaultUnlocked: boolean; }
interface AiDraftResponse { draft: string; model: string; }
interface SavedAiDraft { draft: string; model: string; updatedAt: string; }

function errorText(error: unknown): string { return error instanceof Error ? error.message : 'Action IA impossible.'; }

export default function AiAssistant({ request, selectedApplication, view = "application" }: AiAssistantProps) {
  const keyInput = useRef<HTMLInputElement>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const selectedApplicationIdRef = useRef(selectedApplication?.id);
  selectedApplicationIdRef.current = selectedApplication?.id;
  const draftWritesRef = useRef(new Map<string, Promise<void>>());
  const dirtyDraftRef = useRef<{ applicationId: string; draft: string } | null>(null);
  const draftRevisionRef = useRef(0);
  const draftModelRef = useRef('');
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('');
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const [includeAnswers, setIncludeAnswers] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [dirtyDraft, setDirtyDraft] = useState<{ applicationId: string; draft: string } | null>(null);
  const [draftStatus, setDraftStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    requestRef.current('/ai/config').then((result) => {
      if (!active) return;
      const config = result as AiConfigResponse;
      setSettings(config.settings);
      setVaultUnlocked(config.vaultUnlocked);
      if (config.settings) {
        setBaseUrl(config.settings.baseUrl);
        setModel(config.settings.model);
      }
    }).catch((reason: unknown) => { if (active) setError(errorText(reason)); });
    return () => {
      active = false;
      if (keyInput.current) keyInput.current.value = '';
    };
  }, []);

  useEffect(() => {
    setIncludeAnswers(false);
    setDraft('');
    setDraftModel('');
    draftModelRef.current = '';
    dirtyDraftRef.current = null;
    setDirtyDraft(null);
    setDraftStatus(selectedApplication?.id ? 'Chargement du brouillon…' : '');
    const applicationId = selectedApplication?.id;
    if (!applicationId) return;
    let active = true;
    requestRef.current(`/applications/${encodeURIComponent(applicationId)}/cover-letter-draft`).then((result) => {
      if (!active || selectedApplicationIdRef.current !== applicationId) return;
      const saved = (result as { draft: SavedAiDraft | null }).draft;
      setDraft(saved?.draft || '');
      setDraftModel(saved?.model || '');
      draftModelRef.current = saved?.model || '';
      setDraftStatus(saved ? `Enregistré · ${new Date(saved.updatedAt).toLocaleString('fr-FR')}` : 'Aucun brouillon enregistré.');
    }).catch((reason: unknown) => {
      if (active && selectedApplicationIdRef.current === applicationId) { setDraftStatus(''); setError(errorText(reason)); }
    });
    return () => {
      active = false;
      const pending = dirtyDraftRef.current;
      if (pending?.applicationId === applicationId) void persistDraft(pending.applicationId, pending.draft, draftModelRef.current);
    };
  }, [selectedApplication?.id]);

  function persistDraft(applicationId: string, value: string, valueModel: string): Promise<void> {
    const previous = draftWritesRef.current.get(applicationId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await requestRef.current(`/applications/${encodeURIComponent(applicationId)}/cover-letter-draft`, 'PUT', { draft: value, model: valueModel });
    });
    draftWritesRef.current.set(applicationId, next);
    void next.finally(() => { if (draftWritesRef.current.get(applicationId) === next) draftWritesRef.current.delete(applicationId); }).catch(() => undefined);
    return next.then(() => {
      if (selectedApplicationIdRef.current === applicationId && dirtyDraftRef.current?.draft === value) {
        dirtyDraftRef.current = null; setDirtyDraft(null); setDraftStatus('Enregistré.');
      }
    }).catch((reason: unknown) => {
      if (selectedApplicationIdRef.current === applicationId) { setDraftStatus('Modifications non enregistrées.'); setError(errorText(reason)); }
    });
  }

  useEffect(() => {
    if (!dirtyDraft || dirtyDraft.applicationId !== selectedApplication?.id) return;
    setDraftStatus('Enregistrement…');
    const timer = window.setTimeout(() => { void persistDraft(dirtyDraft.applicationId, dirtyDraft.draft, draftModelRef.current); }, 650);
    return () => window.clearTimeout(timer);
  }, [dirtyDraft, selectedApplication?.id]);

  async function refreshState() {
    setBusy(true); setError('');
    try {
      const config = await requestRef.current('/ai/config') as AiConfigResponse;
      setSettings(config.settings); setVaultUnlocked(config.vaultUnlocked);
      if (config.settings) { setBaseUrl(config.settings.baseUrl); setModel(config.settings.model); }
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
    const apiKey = keyInput.current?.value || '';
    try {
      const result = await requestRef.current('/ai/config', 'POST', { baseUrl, model, apiKey }) as { settings: AiSettings };
      setSettings(result.settings);
      setVaultUnlocked(true);
      setNotice('Configuration enregistrée dans le coffre.');
      if (keyInput.current) keyInput.current.value = '';
    } catch (reason) { setError(errorText(reason)); }
    finally { if (keyInput.current) keyInput.current.value = ''; setBusy(false); }
  }

  async function testConnection() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await requestRef.current('/ai/test', 'POST', {}) as { model: string; message: string };
      setNotice(`${result.message} Modèle : ${result.model}.`);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  async function generateDraft() {
    if (!selectedApplication) return;
    const requestedApplicationId = selectedApplication.id;
    const revision = draftRevisionRef.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const pending = dirtyDraftRef.current;
      if (pending?.applicationId === requestedApplicationId) await persistDraft(requestedApplicationId, pending.draft, draftModelRef.current);
      const result = await requestRef.current('/ai/cover-letter', 'POST', { applicationId: requestedApplicationId, includeAnswers }) as AiDraftResponse;
      if (selectedApplicationIdRef.current !== requestedApplicationId) return;
      draftModelRef.current = result.model;
      setDraftModel(result.model);
      if (draftRevisionRef.current === revision) { setDraft(result.draft); dirtyDraftRef.current = null; setDirtyDraft(null); setDraftStatus('Brouillon généré et enregistré.'); }
      else { const latest = dirtyDraftRef.current; if (latest?.applicationId === requestedApplicationId) { setDirtyDraft(latest); void persistDraft(requestedApplicationId, latest.draft, result.model); } }
      setNotice('Brouillon généré. Relisez et corrigez les faits avant toute utilisation.');
    } catch (reason) { if (selectedApplicationIdRef.current === requestedApplicationId) setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  async function removeConfig() {
    setBusy(true); setError(''); setNotice('');
    try {
      await requestRef.current('/ai/config', 'DELETE');
      setSettings(null); setModel('');
      setNotice('Configuration IA supprimée du coffre.');
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  return <section className="ai-assistant" aria-labelledby="ai-assistant-title">
    <div className="ai-assistant__heading">
      <div>
        <span className="ai-assistant__eyebrow">AIDE À LA CANDIDATURE</span>
        <h2 id="ai-assistant-title">Assistant IA</h2>
        <p>Configurez votre fournisseur compatible OpenAI, testez la connexion puis générez un brouillon à partir d’une candidature sélectionnée.</p>
      </div>
      <span className={`ai-assistant__status ${settings ? 'is-configured' : ''}`}>{settings ? `Configuré · ${settings.model}` : 'Non configuré'}</span>
    </div>

    {!vaultUnlocked && <p className="ai-assistant__notice">Déverrouillez le coffre dans Paramètres &gt; Connexions avant d’enregistrer ou d’utiliser une clé API.</p>}

    {view === "connection" && <form className="ai-assistant__form" onSubmit={save}>
      <label>URL de base HTTPS
        <input type="url" required maxLength={2000} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" autoComplete="url" />
      </label>
      <label>Modèle
        <input required maxLength={200} value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4.1-mini" autoComplete="off" />
      </label>
      <label>Clé API
        <input ref={keyInput} type="password" required maxLength={2000} placeholder="Saisie temporaire, jamais réaffichée" autoComplete="new-password" spellCheck={false} />
      </label>
      <div className="ai-assistant__actions">
        <button className="ai-assistant__primary" type="submit" disabled={busy || !vaultUnlocked}>Enregistrer la configuration</button>
        <button type="button" onClick={refreshState} disabled={busy}>Actualiser l’état du coffre</button>
        <button type="button" onClick={testConnection} disabled={busy || !settings || !vaultUnlocked}>Tester la connexion</button>
        {settings && <button type="button" className="ai-assistant__danger" onClick={removeConfig} disabled={busy || !vaultUnlocked}>Supprimer</button>}
      </div>
    </form>}

    <div className="ai-assistant__privacy">
      La clé est chiffrée dans le coffre. Le test de connexion n’envoie aucune donnée de profil. Pour un brouillon, l’offre et les informations professionnelles sélectionnées sont transmises au fournisseur configuré. Les champs structurés de coordonnées et le fichier CV ne sont pas joints ; toutefois, le résumé, les descriptions libres du profil et l’offre peuvent contenir des données personnelles que vous y avez saisies.
    </div>

    {view === "application" && <div className="ai-assistant__draft">
      <div>
        <h3>Brouillon de lettre</h3>
        <p>La génération ne soumet pas la candidature. Le résultat reste à vérifier et à copier manuellement.</p>
      </div>
      {selectedApplication ? <div className="ai-assistant__application" aria-live="polite">
        <strong>{selectedApplication.title}</strong>
        <span>{selectedApplication.company}</span>
      </div> : <small>Sélectionnez une candidature pour afficher son offre.</small>}
      <label className="ai-assistant__checkbox">
        <input type="checkbox" checked={includeAnswers} onChange={(event) => setIncludeAnswers(event.target.checked)} disabled={busy} />
        <span>{selectedApplication ? `Inclure les réponses pour ${selectedApplication.title} chez ${selectedApplication.company} (elles seront envoyées au fournisseur IA)` : 'Inclure les réponses (disponible après sélection d’une candidature)'}</span>
      </label>
      <button className="ai-assistant__primary" type="button" onClick={generateDraft} disabled={busy || !settings || !vaultUnlocked || !selectedApplication}>
        {busy ? 'Traitement…' : 'Générer le brouillon'}
      </button>
      {!selectedApplication && <small>Sélectionnez d’abord une candidature pour activer la génération.</small>}
      {draftStatus && <small role="status">{draftStatus}</small>}
      {selectedApplication && <label>{draft ? `Brouillon modifiable · ${draftModel}` : 'Brouillon de lettre'}
        <textarea value={draft} maxLength={12000} onChange={(event) => {
          const next = event.target.value;
          draftRevisionRef.current += 1;
          setDraft(next);
          const pending = { applicationId: selectedApplication.id, draft: next };
          dirtyDraftRef.current = pending; setDirtyDraft(pending);
        }} onBlur={() => { const pending = dirtyDraftRef.current; if (pending?.applicationId === selectedApplication.id) void persistDraft(pending.applicationId, pending.draft, draftModelRef.current); }} rows={10} placeholder="Générez ou rédigez votre brouillon ici…" />
      </label>}
    </div>}

    {notice && <p className="ai-assistant__notice" role="status">{notice}</p>}
    {error && <p className="ai-assistant__error" role="alert">{error}</p>}
  </section>;
}

