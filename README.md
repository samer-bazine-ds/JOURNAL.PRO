# JournalPro Electron

Application de bureau Electron avec un renderer React + TypeScript.

## Commandes

- `npm run dev` : démarre Vite et Electron en développement.
- `npm run typecheck` : vérifie les types TypeScript.
- `npm run build` : produit le renderer dans `dist/`.
- `npm run dist` : crée l'installateur Windows avec electron-builder.

## Structure

- `electron/` : processus principal et preload sécurisé.
- `src/components/` : composants d'interface partagés.
- `src/pages/` : pages Import, Révision, Correspondances et Plan comptable.
- `src/services/` : génération/export du journal et persistance.
- `src/data/` : règles et comptes par défaut.
- `pdf-parser.js` : moteur d'extraction PDF existant, désormais chargé comme module ES local avec le worker npm de PDF.js.

Toutes les dépendances navigateur sont empaquetées localement; aucun CDN n'est nécessaire.

## Contrôle administratif distant

Définissez `JOURNALPRO_CONTROL_ENDPOINT` avec une URL HTTPS avant de démarrer ou distribuer l'application. Electron vérifie cette URL au démarrage puis toutes les 15 minutes.

Vous pouvez aussi le placer dans `.env` à la racine du projet :

```dotenv
JOURNALPRO_CONTROL_ENDPOINT="https://github.com/OWNER/REPOSITORY/blob/main/control.txt"
```

Après une modification de `.env`, arrêtez puis redémarrez complètement `npm run dev`. Un simple rechargement de la page Vite ne redémarre pas le processus principal Electron.

Contenu normal : `active`.

Contenu de désactivation : `desactive`, avec un message facultatif sur les lignes suivantes.

La source doit être un fichier texte public GitHub. Les liens `github.com/.../blob/...`, `github.com/.../edit/...` et `raw.githubusercontent.com/...` sont acceptés. Les liens `blob` et `edit` sont automatiquement convertis vers le contenu brut. La première ligne contient la commande et les lignes suivantes peuvent contenir le message :

```text
desactive
Licence suspendue. Contactez le support.
```

Les deux seules commandes reconnues sont `active` et `desactive` (insensibles à la casse). Tout autre contenu est rejeté et l'état local précédemment enregistré est conservé.

Chaque réponse valide est enregistrée dans le dossier de données utilisateur d'Electron (`control-status.json`). Si la dernière réponse confirmée était `disabled`, l'application reste désactivée hors connexion et après redémarrage. Seule une réponse ultérieure valide avec `active` la réactive. Lors d'une première utilisation sans état enregistré, une erreur réseau laisse l'application active.

Ce mécanisme désactive l'interface sans supprimer l'application ni les données comptables de l'utilisateur.

### Journal de diagnostic

Chaque vérification est affichée dans le terminal Electron et ajoutée à `control.log` dans le dossier de données utilisateur Electron. Le journal contient la source demandée, le type de source, le statut HTTP, le contenu reçu (limité à 4 Ko), le résultat du parsing, les erreurs, l'utilisation éventuelle du cache et la décision finale. Les paramètres de requête et identifiants d'URL sont masqués.
