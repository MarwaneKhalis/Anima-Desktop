# Vérification

## Résultats actuels — 8 octobre 2026

La version bureau locale passe la suite complète (**139 tests, 0 échec**), `pnpm build` et `pnpm desktop:compile`. Le workflow Windows [#26](https://github.com/MarwaneKhalis/Anima-Desktop/actions/runs/37792409210), sur le commit `4585794`, a réussi le build, les tests, l’installateur NSIS, le smoke de l’application extraite et l’installation fraîche dans un profil temporaire avec sandbox Chromium actif. Le smoke vérifie le démarrage, l’absence de serveur exposé, la préparation sans envoi, l’envoi vers une fixture et la persistance après redémarrage. Ce commit comprend SmartRecruiters et Teamtailor; Workday est maintenant couvert localement et son contrôle Windows est lancé sur le commit de suivi.

Les adaptateurs Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters, Teamtailor et Workday sont testés avec des formulaires synthétiques. Le formulaire Teamtailor observé directement n’était pas lisible par l’outil de consultation; son chemin d’application reste exercé avec la fixture et la convention officielle `/applications/new`. Workday utilise un formulaire configurable selon l’employeur; les comptes à créer, étapes de sécurité et réponses inconnues restent à compléter dans le navigateur. Aucun site carrière réel n’a reçu de candidature. Le commit Windows `5d274eb` a eu un échec de build dû à des fichiers partiellement transférés; son contenu complet a été restauré dans `4585794`, dont le contrôle Windows a réussi.

### Résultats historiques — 7 octobre 2026

Windows, Node.js 24, Chromium Playwright. La suite complète comptait **71 tests réussis, 0 échec, 0 ignoré**. `pnpm build` et `pnpm desktop:compile` réussissaient ; l’installateur NSIS x64 avait été généré.

| Vérification bureau                                        | Résultat                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| Installation NSIS par utilisateur dans un dossier isolé    | Réussie                                                   |
| Démarrage de l’EXE installé avec le sandbox Electron actif | Réussi                                                    |
| Accès AppContainer à `icudtl.dat` et à l’EXE               | ACE `RX` confirmée                                        |
| Préparation sans envoi puis envoi fixture                  | Aucun POST en préparation, un seul POST fixture à l’envoi |
| Reçu et reprise après redémarrage                          | Réussis                                                   |
| Instance unique et écoute HTTP locale                      | Deuxième instance fermée ; aucun serveur HTTP détecté     |

L’installation a été vérifiée dans un chemin isolé du profil Windows courant, pas dans une nouvelle session utilisateur ou une machine virtuelle vierge. L’installateur n’est pas signé par un certificat éditeur ; SmartScreen peut afficher un avertissement. Aucun site carrière réel n’a reçu de candidature pendant les tests.

## Résultats historiques — 6 octobre 2026

## Résultat local

Windows, Node.js 24, Chromium Playwright. TypeScript `--noEmit` et build Vite standard réussis. Suite complète : **50 tests réussis, 0 échec, 0 ignoré**, durée 49,6 secondes sur la dernière exécution après intégration des commits.

| Vérification                    | Preuve                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Candidature simple et CV choisi | POST reçu par le serveur fictif ; fichier, MIME, octets et SHA-256 comparés                                     |
| Préparation                     | Aucun POST final avant lancement de l'envoi                                                                     |
| Plusieurs étapes                | Identité → CV/question → récapitulatif → reçu                                                                   |
| Connexion et redirection ATS    | Compte fourni uniquement à l'origine exacte du site de destination                                              |
| Réponses personnelles           | Champs inconnus bloqués, defaults ignorés, radios Yes/No cohérents, réponses candidature prioritaires           |
| Secret                          | Chiffrement authentifié, altération rejetée, espaces conservés, aucun mot de passe dans API/disque/log d'erreur |
| Envoi incertain                 | Un POST sans reçu → uncertain ; nouvel envoi refusé après redémarrage                                           |
| Interruption/concurrence        | État durable avant clic, stop avant/après clic, deuxième parcours HTTP 409                                      |
| Fichiers                        | PDF/DOCX ; upload HTTP 5 Mio ; limite 10 Mio ; nom Unicode téléchargé                                           |
| Interface                       | Profil, deux CV, choix explicite, offre, préparation, envoi, reçu, reload et deux lots successifs               |
| Mobile/CRM                      | Vue 390 × 844 sans débordement ; prospection intégrée avec une seule barre latérale                             |
| API locale                      | Header de mutation, Origin, Host hostile et Sec-Fetch-Site contrôlés                                            |
| Ancienne prospection            | Les neuf tests métier existants réussissent                                                                     |

L'architecte a revu les branches avant commit, fait reproduire puis corriger les défauts et donné son accord final. Son contrôle indépendant de restauration a vérifié le retour du profil, des octets/SHA du CV, du compte chiffré et du coffre verrouillé puis déverrouillable avec sa phrase originale.

## Découverte réelle, en lecture seule

Le 6 octobre 2026, le moteur a lu les tableaux publics :

- Greenhouse Figma : **162 offres** trouvées.
- Lever Spotify : **80 offres** trouvées.

Ces nombres sont un constat de test, pas des données de démonstration permanentes. La découverte JSON-LD et le refus des redirections vers des adresses privées sont couverts par un serveur local fictif.

## Captures reproductibles

`tests/career-ui.test.ts` génère les captures suivantes dans `artifacts/career-ui/` :

1. `01-dashboard.png`
2. `02-profile.png`
3. `03-offers.png`
4. `04-application-ready.png`
5. `05-receipt.png`
6. `06-mobile.png`
7. `07-prospecting.png`

Les captures proviennent d'une exécution réelle sur données synthétiques. Elles sont exclues de Git et conservées comme artefact par la CI.

## Portée des résultats

Aucune candidature de test n'a été envoyée à un employeur réel. La réussite sur les fixtures ne certifie pas tous les portails de recrutement. Les contrôles CAPTCHA/MFA, SSO, nouveaux comptes et formulaires propriétaires non reconnus demandent une intervention. La prospection LinkedIn garde l'envoi manuel de la version précédente ; les résultats métier des candidatures se renseignent manuellement. Ces limites sont visibles dans l'interface et décrites dans le README.
