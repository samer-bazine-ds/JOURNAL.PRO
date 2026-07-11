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
JOURNALPRO_CONTROL_ENDPOINT="file:///C:/JournalPro/control.txt"
```

Après une modification de `.env`, arrêtez puis redémarrez complètement `npm run dev`. Un simple rechargement de la page Vite ne redémarre pas le processus principal Electron.

Réponse normale :

```json
{ "status": "active" }
```

Réponse de désactivation :

```json
{ "status": "disabled", "message": "Licence suspendue. Contactez le support." }
```

La source peut aussi être un fichier texte distant, une URL `file://` ou un chemin local. La première ligne contient la commande et les lignes suivantes peuvent contenir le message :

```text
disabled
Licence suspendue. Contactez le support.
```

Commandes actives reconnues : `active`, `enabled`, `enable`, `keep working`, `keep`.

Commandes de désactivation reconnues : `disabled`, `disable`, `inactive`, `stop`, `blocked`.

Exemple avec un fichier local :

```powershell
$env:JOURNALPRO_CONTROL_ENDPOINT="C:\JournalPro\control.txt"
npm run dev
```

Chaque réponse valide est enregistrée dans le dossier de données utilisateur d'Electron (`control-status.json`). Si la dernière réponse confirmée était `disabled`, l'application reste désactivée hors connexion et après redémarrage. Seule une réponse ultérieure valide avec `active` la réactive. Lors d'une première utilisation sans état enregistré, une erreur réseau laisse l'application active.

Ce mécanisme désactive l'interface sans supprimer l'application ni les données comptables de l'utilisateur.
