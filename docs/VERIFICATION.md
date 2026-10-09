# Vérification

## Résultats actuels — 8 octobre 2026

La version bureau locale passe la suite complète (**166 tests, 0 échec**), `pnpm build` et `pnpm desktop:compile`. La recherche par défaut interroge en parallèle Arbeitnow, Jobicy, Remote OK et Himalayas, conserve l’attribution des offres, répartit les résultats et tolère l’indisponibilité d’une source. Le filtre ville est appliqué aux sources qui le prennent en charge; Himalayas reçoit une recherche sans ville, y compris avec un profil renseigné à Paris. Le mode test neutralise les flux non simulés, utilise un transport France Travail simulé et refuse les URL de fixture qui ne pointent pas vers une origine locale autorisée. Le parcours UI utilise les métiers du profil comme mots-clés par défaut, sans URL copiée. Des tests couvrent les campagnes multi-source, les filtres et caches bornés, les parcours ATS simulés, et le blocage d’un redirecteur vers un domaine inconnu avant envoi. Les redirections d’une fiche vers un ATS, même au sein d’un même fournisseur, sont bloquées tant que l’utilisateur n’a pas sélectionné un lien Apply visible vers l’hôte exact; les tests vérifient qu’aucun compte ni aucune candidature ne sont transmis. Les Service Workers et les WebSockets vers des origines externes sont bloqués dans le navigateur isolé pour empêcher le contournement du filtre réseau; des fixtures vérifient ces deux protections. Les ressources ATS entre origines ne sont acceptées que si elles appartiennent au même compte employeur. Aucun site carrière réel n’a reçu de candidature.

Le précédent commit 695e867 a passé les deux workflows Windows [push](https://github.com/MarwaneKhalis/Anima-Desktop/actions/runs/37818605983) et [pull request](https://github.com/MarwaneKhalis/Anima-Desktop/actions/runs/37818611972) : build, tests, création de l’EXE, smoke dépaqueté, installation NSIS et smoke de l’application installée. Le durcissement de sécurité de ce nouveau commit doit passer ses propres contrôles Windows avant fusion.

La validation DNS vérifie que les noms utilisés au démarrage et lors des redirections ne résolvent pas vers une adresse privée. Chromium résout ensuite le nom au moment de la connexion : l’épinglage DNS et la protection complète contre un changement de réponse entre ces deux étapes restent à renforcer.

Les adaptateurs Greenhouse, Lever, Ashby, Recruitee, Workable, SmartRecruiters, Teamtailor et Workday sont testés avec des formulaires synthétiques. Le formulaire Teamtailor observé directement n’était pas lisible par l’outil de consultation; son chemin d’application reste exercé avec la fixture et la convention officielle `/applications/new`. Workday utilise un formulaire configurable selon l’employeur; les comptes à créer, étapes de sécurité et réponses inconnues restent à compléter dans le navigateur. Les tests Remote OK utilisent un redirecteur et un ATS fictifs; ils n’envoient rien à un employeur.

Les appels aux flux externes sont bornés en durée et en taille. La disponibilité live de l’API Himalayas n’a pas pu être vérifiée depuis cet environnement (accès réseau externe bloqué) ; son format et ses filtres sont couverts avec des réponses synthétiques conformes au contrat d’API.

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
