import type { ApplicationState, CareerEmployerResponse, Outcome } from "./career.ts";
import type { Message, QueueItem } from "./types.ts";

export interface StateMeta {
  label: string;
  description: string;
}
export type CampaignState = "queued" | "running" | "paused" | "stopped" | "completed" | "limit_reached";
export type CampaignItemState = "pending" | "running" | "submitted" | "needs_input" | "uncertain" | "failed" | "skipped";

export const APPLICATION_STATE_META: Record<ApplicationState, StateMeta> = {
  draft: { label: "À préparer", description: "Aucune tentative d’envoi n’a été faite." },
  running: { label: "En cours", description: "L’automatisation travaille; la confirmation d’envoi reste distincte." },
  ready: { label: "Prête", description: "La préparation est terminée; l’envoi attend votre action." },
  needs_input: { label: "Réponse requise", description: "L’automatisation est en pause jusqu’à votre intervention." },
  blocked: { label: "Action requise", description: "Une action manuelle est nécessaire pour continuer." },
  submitting: { label: "Envoi en cours", description: "Une action d’envoi a été déclenchée; attendez sa confirmation." },
  submitted: { label: "Envoyée", description: "Le portail a confirmé la soumission de la candidature." },
  uncertain: { label: "Envoi à vérifier", description: "Le résultat n’est pas confirmé; vérifiez le portail avant toute nouvelle tentative." },
  failed: { label: "À reprendre", description: "L’automatisation s’est arrêtée; vérifiez l’état de la candidature avant de reprendre." },
};
export const APPLICATION_STATE_LABELS = Object.fromEntries(
  Object.entries(APPLICATION_STATE_META).map(([key, meta]) => [key, meta.label]),
) as Record<ApplicationState, string>;

export const EMPLOYER_OUTCOME_META: Record<Outcome, StateMeta> = {
  active: { label: "En attente", description: "Aucun résultat employeur final n’est renseigné; votre suivi reste ouvert." },
  interview: { label: "Entretien", description: "Entretien renseigné dans le suivi après un retour de l’employeur." },
  offer: { label: "Offre reçue", description: "Offre renseignée dans le suivi après un retour de l’employeur." },
  rejected: { label: "Refus", description: "Refus renseigné dans le suivi après un retour de l’employeur." },
  withdrawn: { label: "Retirée", description: "Candidature retirée du suivi par l’utilisateur." },
};
export const EMPLOYER_RESPONSE_TYPE_LABELS: Record<CareerEmployerResponse["type"], string> = {
  interview: "Entretien proposé",
  offer: "Offre reçue",
  rejection: "Refus reçu",
  request: "Demande ou question",
  other: "Autre retour",
};
export const EMPLOYER_RESPONSE_CHANNEL_LABELS: Record<CareerEmployerResponse["channel"], string> = {
  email: "E-mail",
  phone: "Téléphone",
  portal: "Portail carrière",
  linkedin: "LinkedIn",
  other: "Autre canal",
};

export const EMPLOYER_OUTCOME_LABELS = Object.fromEntries(
  Object.entries(EMPLOYER_OUTCOME_META).map(([key, meta]) => [key, meta.label]),
) as Record<Outcome, string>;

export const CAMPAIGN_STATE_META: Record<CampaignState, StateMeta> = {
  queued: { label: "En attente", description: "Campagne créée et en attente de démarrage." },
  running: { label: "En cours", description: "La campagne traite ses candidatures une par une." },
  paused: { label: "En pause", description: "La campagne est suspendue jusqu’à sa reprise." },
  stopped: { label: "Arrêtée", description: "La campagne ne reprendra pas sans action de votre part." },
  completed: { label: "Terminée", description: "Tous les éléments de la campagne ont été traités." },
  limit_reached: { label: "Plafond atteint", description: "La limite d’envois définie pour cette campagne a été atteinte." },
};
export const CAMPAIGN_STATE_LABELS = Object.fromEntries(
  Object.entries(CAMPAIGN_STATE_META).map(([key, meta]) => [key, meta.label]),
) as Record<CampaignState, string>;

export const CAMPAIGN_ITEM_STATE_META: Record<CampaignItemState, StateMeta> = {
  pending: { label: "En attente", description: "Cet élément attend son tour dans la campagne." },
  running: { label: "En cours", description: "La candidature est en cours de traitement." },
  submitted: { label: "Envoyée", description: "Le portail a confirmé la soumission." },
  needs_input: { label: "Réponse requise", description: "Une intervention manuelle est requise." },
  uncertain: { label: "Envoi à vérifier", description: "Vérifiez le portail avant toute nouvelle tentative." },
  failed: { label: "Échec avant envoi", description: "L’élément a échoué avant confirmation de soumission." },
  skipped: { label: "Passée", description: "Cet élément n’a pas été envoyé par cette campagne." },
};
export const CAMPAIGN_ITEM_STATE_LABELS = Object.fromEntries(
  Object.entries(CAMPAIGN_ITEM_STATE_META).map(([key, meta]) => [key, meta.label]),
) as Record<CampaignItemState, string>;

export const MESSAGE_STATE_META: Record<Message["state"], StateMeta> = {
  draft: { label: "Brouillon", description: "Le message est préparé et n’a pas été envoyé." },
  sent: { label: "Envoyé", description: "L’utilisateur a confirmé l’envoi manuel du message." },
};
export const MESSAGE_STATE_LABELS = Object.fromEntries(
  Object.entries(MESSAGE_STATE_META).map(([key, meta]) => [key, meta.label]),
) as Record<Message["state"], string>;

export const NETWORK_QUEUE_STATE_META: Record<QueueItem["state"], StateMeta> = {
  pending: { label: "En attente", description: "L’action attend votre vérification et une confirmation manuelle." },
  open: { label: "Profil ouvert", description: "Le profil a été ouvert; aucun message n’a été envoyé." },
  sent: { label: "Envoi confirmé", description: "L’utilisateur a confirmé l’envoi manuel du message ou de l’invitation." },
  uncertain: { label: "À vérifier", description: "Vérifiez manuellement si l’action a abouti avant de la répéter." },
  cancelled: { label: "Annulée", description: "L’action a été annulée et ne sera pas envoyée." },
};
export const NETWORK_QUEUE_STATE_LABELS = Object.fromEntries(
  Object.entries(NETWORK_QUEUE_STATE_META).map(([key, meta]) => [key, meta.label]),
) as Record<QueueItem["state"], string>;
