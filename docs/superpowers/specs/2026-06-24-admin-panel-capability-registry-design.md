# Refonte du panneau admin — Registre de capacités (portable XEP-0133)

**Date** : 2026-06-24
**Statut** : Design validé (sections 1–3 approuvées en brainstorming ; section 4 conçue, à confirmer)
**Branche** : `mr/vigorous-edison-47531c`

## Contexte et stratégie

Le panneau admin actuel est déjà *discovery-driven* (catégories Users / Rooms / Announcements / Other),
mais les catégories « Announcements » et « Other » rendent encore des **formulaires XEP-0050 génériques**
(auto-rendu de `AdminCommandForm.tsx` à partir des champs XEP-0004 annoncés par le serveur). Ce sont les
« commandes brutes ».

Deux objectifs guident la refonte :

1. **Cacher les commandes brutes.** Pour chaque commande, se demander *où* et *sous quelle forme* elle
   peut être utilisée, et lui donner une UI conçue. Une commande non reconnue n'apparaît pas.
2. **Tester sur le subset standard XEP-0133**, pour qu'un serveur autre qu'ejabberd (Prosody, etc.)
   s'administre proprement.

### Décisions de cadrage (validées)

- **Aucun rendu générique.** On supprime l'auto-renderer de formulaire du flux par défaut. Chaque
  capacité exposée a un composant dédié. Un nœud non mappé est **ignoré** (loggé en dev pour faire
  grandir le registre), jamais rendu en prod.
- **Standard d'abord, ejabberd en bonus.** L'UI repose sur le set XEP-0133 (`http://jabber.org/protocol/admin#*`),
  portable partout. Les `api-commands/*` ejabberd ne servent que d'enrichissement quand elles existent
  (uptime, comptage de salons…), jamais requises pour une fonction de base. Dégradation gracieuse.
- **Périmètre** : tout XEP-0133 **sauf** `restart` / `shutdown` (contrôle serveur).
  - `get-user-password` **retiré** : sous SCRAM (défaut ejabberd *et* Prosody), le serveur ne stocke
    qu'un dérivé salé — aucun plaintext à renvoyer. Une action qui échoue selon le stockage du serveur
    viole le principe « chaque commande exposée fonctionne ». `change-user-password` reste (le serveur
    re-dérive le SCRAM à partir du nouveau mot de passe).
  - `edit-admin` **gardé**, avec auto-masquage de la surface si le serveur ne l'annonce pas (certains
    serveurs ont une liste d'admins en config statique).
  - `edit-blacklist` / `edit-whitelist` **hors périmètre** (YAGNI) — ajout futur facile via une
    surface `access`.
- **Gestion des salons (Rooms)** : la liste MUC via disco, `fetchRoomOptions`, destroy room **ne sont
  pas** du XEP-0133 et restent **inchangés**, hors du registre admin-commands.

## Approche retenue : registre déclaratif de capacités

L'UI est indexée sur des **capacités logiques**, jamais sur des nœuds de commande. Un nœud (standard ou
ejabberd) se résout vers une capacité ; les composants ne connaissent que les capacités. Standard vs
ejabberd devient invisible côté UI.

### Section 1 — Ossature

```ts
type CapabilityId =
  | 'user.add' | 'user.delete' | 'user.disable' | 'user.reenable'
  | 'user.endSession' | 'user.changePassword'
  | 'user.getRoster' | 'user.lastLogin' | 'user.stats'
  | 'users.registeredCount' | 'users.registeredList'
  | 'users.disabledCount'  | 'users.disabledList'
  | 'users.onlineCount'    | 'users.onlineList'
  | 'announce.broadcast' | 'announce.motd' | 'announce.welcome'
  | 'admins.edit'
  // enrichissements ejabberd : 'stats.uptime', 'rooms.onlineCount', 'server.version'

type AdminSurface = 'overview' | 'userList' | 'userDetail' | 'announcements' | 'admins'
type AdminUiKind  = 'card' | 'listSource' | 'rowAction' | 'readPanel' | 'composer' | 'editor'

interface AdminCapability {
  id: CapabilityId
  standardNode: string | null   // nœud XEP-0133 ; null = capacité purement ejabberd
  ejabberdNodes?: string[]      // api-commands/* satisfaisant la même capacité
  surface: AdminSurface
  uiKind: AdminUiKind
  danger: 'none' | 'confirm' | 'destructive'
  labelKey: string
}
```

**Flux de résolution** (remplace `categorizeCommand` dans `Admin.ts`) :

1. La découverte disco#items reste inchangée → liste de nœuds annoncés.
2. `resolveCapability(node)` cherche le nœud dans le registre (`standardNode` puis `ejabberdNodes`).
   Inconnu → `null` → ignoré (collecté dans `unmappedNodes` pour diagnostic dev).
3. Le store expose `availableCapabilities: Set<CapabilityId>` + `resolvedNodes: Map<CapabilityId, string>`
   (pour l'exécution).
4. Chaque *surface* demande « quelles de mes capacités sont présentes ? » et rend son composant dédié.
   Surface sans aucune capacité → masquée entièrement.

**« Pas de générique » ≠ « pas de formulaires ».** `announce`, `edit-motd` *sont* des formulaires, mais
rendus par un composant *conçu* (composer placé dans Announcements), pas par l'auto-renderer XEP-0004.
Les composants dédiés réutilisent `DataFormFields` comme primitive si utile, mais possèdent leur
layout/labels et soumettent contre les vars de form standard XEP-0133.

### Section 2 — Table commande → emplacement → forme

Nœuds standard = `http://jabber.org/protocol/admin#<nom>`.

#### Surface `userDetail` (actions sur un JID sélectionné)

| Capacité | Nœud standard | uiKind | Danger | Forme |
|---|---|---|---|---|
| `user.changePassword` | `change-user-password` | rowAction | confirm | Dialog : 1 champ mot de passe |
| `user.endSession` | `end-user-session` | rowAction | confirm | Confirm simple |
| `user.disable` / `user.reenable` | `disable-user` / `reenable-user` | rowAction | confirm | Toggle selon état |
| `user.delete` | `delete-user` | rowAction | destructive | Confirm fort (re-saisie du JID) |
| `user.getRoster` | `get-user-roster` | readPanel | none | Liste lecture seule des contacts |
| `user.stats` | `user-stats` | readPanel | none | Paires clé/valeur |
| `user.lastLogin` | `get-user-lastlogin` | readPanel | none | Lazy-fetch en liste ; détail = date complète |

#### Surface `userList` (liste + recherche)

| Capacité | Nœud standard | uiKind | Forme |
|---|---|---|---|
| `users.registeredList` | `get-registered-users-list` | listSource | Source paginée RSM |
| `users.onlineList` | `get-online-users-list` | listSource | Snapshot → pastille en ligne (absent = pas de pastille) |
| `users.disabledList` | `get-disabled-users-list` | listSource | Onglet/filtre « désactivés » (absent = pas d'onglet) |
| `user.add` | `add-user` | composer | Bouton « Ajouter » → modale (JID + mot de passe) |

#### Surface `overview` (cartes vitales)

| Capacité | Nœud standard | ejabberd bonus | uiKind |
|---|---|---|---|
| `users.registeredCount` | `get-registered-users-num` | — | card |
| `users.onlineCount` | `get-online-users-num` | — | card |
| `users.disabledCount` | `get-disabled-users-num` | — | card |
| `stats.uptime` | — | `api-commands/stats` | card (ejabberd seul) |
| `rooms.onlineCount` | — | `api-commands/muc_online_rooms_count` | card (ejabberd seul) |
| `server.version` | — | XEP-0092 (déjà implémenté) | card |

#### Surface `announcements`

| Capacité | Nœuds standard | uiKind | Forme |
|---|---|---|---|
| `announce.broadcast` | `announce` | composer | Composer : corps + sujet, bouton « Diffuser » |
| `announce.motd` | `set-motd` / `edit-motd` / `delete-motd` | editor | Éditeur MOTD (charger / éditer / effacer) |
| `announce.welcome` | `set-welcome` / `delete-welcome` | editor | Éditeur message de bienvenue |

#### Surface `admins`

| Capacité | Nœud standard | uiKind | Danger | Forme |
|---|---|---|---|---|
| `admins.edit` | `edit-admin` | editor | confirm | Éditeur jid-multi (liste des admins) |

### Section 3 — Impact sur le code

**SDK (`packages/fluux-sdk`)**

- **Nouveau** `core/admin/capabilityRegistry.ts` — la table en données + `resolveCapability(node): CapabilityId | null`
  et `nodeForCapability(id): string | null`.
- `core/modules/Admin.ts` — `categorizeCommand()` **supprimé**, remplacé par une passe de résolution :
  la découverte produit `availableCapabilities: Set<CapabilityId>` + `resolvedNodes: Map<CapabilityId, string>` ;
  nœuds non résolus → `unmappedNodes` (dev only).
- `stores/adminStore.ts` — `commands` / `commandsByCategory` remplacés par `availableCapabilities` +
  `resolvedNodes` + `unmappedNodes`. `currentSession` **reste** (composers/éditeurs s'en servent pour les
  forms multi-étapes).
- `hooks/useAdmin.ts` — expose `hasCapability(id)`, `executeCapability(id, formData?)` (résout le nœud en
  interne), garde `submitForm` / `previousStep` / `cancelCommand`. `commandsByCategory` disparaît de l'API publique.
- `core/types/admin.ts` — ajoute `CapabilityId`, `AdminCapability`, `AdminSurface`, `AdminUiKind`.

**App (`apps/fluux/src`)**

- `AdminCommandForm.tsx` (auto-renderer générique) — **retiré du flux par défaut**. `DataFormFields.tsx`
  **conservé** comme primitive réutilisée par les composants dédiés.
- `AdminDashboard.tsx` — navigation pilotée par les *surfaces ayant ≥1 capacité*. Surface vide = entrée masquée.
- `ServerOverview.tsx` — cartes pilotées par capacité (`OVERVIEW_CARDS` basculé sur `CapabilityId`).
- `AdminUserView.tsx` — nœuds hardcodés → `hasCapability(...)` + `executeCapability(...)` ; ajout des
  readPanels (roster, stats).
- **Nouveaux composants dédiés** : `AnnouncementsView` (composer broadcast + éditeurs MOTD/welcome) et
  `AdminsView` (éditeur jid-multi) — remplacent le rendu générique des anciennes catégories
  « Announcements » / « Other ».
- `unmappedNodes` jamais rendus en prod ; encart de debug dev-only pour les lister.

**Principe de découpage** : le registre est la seule source de vérité « nœud → capacité → surface ».
Aucun composant ne référence de chaîne de nœud en dur ; ils parlent capacités. Ajouter une commande =
une ligne de registre + (si forme nouvelle) un composant de surface.

### Section 4 — Serveur démo « XEP-0133 pur » + tests (à confirmer)

Objectif : valider la dégradation gracieuse **sans serveur réel**, en simulant un serveur qui n'annonce
que le set standard (aucune `api-commands/*`).

- **Demo** : profil `StandardAdminProfile` pour `DemoClient` qui annonce uniquement les nœuds XEP-0133.
  Permet de vérifier de visu que les cartes/surfaces purement ejabberd (`stats.uptime`,
  `rooms.onlineCount`) disparaissent et que le reste fonctionne. Un toggle démo « serveur standard vs
  ejabberd étendu » serait l'idéal pour comparer côte à côte.
- **Tests unitaires SDK** (`capabilityRegistry.test.ts`) :
  - `resolveCapability(standardNode)` → bonne capacité.
  - `resolveCapability(ejabberdNode)` → même capacité que son équivalent standard.
  - nœud inconnu → `null`.
  - aucun doublon de `CapabilityId` ; chaque capacité a `standardNode` **ou** au moins un `ejabberdNode`.
- **Tests de surface** (app) : étant donné un `Set<CapabilityId>`, chaque surface rend les composants
  attendus et se masque quand l'ensemble est vide. Cas clé : ensemble « standard pur » → surfaces
  ejabberd-seules masquées.
- **Validation finale optionnelle** : une vraie instance Prosody (`mod_admin_adhoc`) — non requise pour le
  MVP, le profil démo standard couvre le développement quotidien.

## Risques / points ouverts

- **Détection de form vars** : les composers dédiés soumettent contre les vars standard XEP-0133. Si un
  serveur expose des vars légèrement différentes, lire le data-form annoncé à l'exécution (déjà présent
  via `currentSession`) sert de garde-fou.
- **Couverture du registre** : les `unmappedNodes` en dev sont le mécanisme pour repérer ce qui manque ;
  prévoir une passe initiale contre ejabberd réel pour amorcer le mapping ejabberd↔standard.
- **i18n** : nouvelles clés pour les surfaces `announcements` / `admins` et les readPanels — à traduire
  dans les 33 locales (pas de placeholder anglais).

## Prochaine étape

Confirmer la Section 4, puis passer à la rédaction du plan d'implémentation (skill `writing-plans`).
