# Navigation clavier + manette sur tous les écrans — conception

Issue [#123](https://github.com/lionrayonnant/FPVThePlanet/issues/123). Fait suite à la
PHASE 19 (#56, PR #119).

## Pourquoi

Après la passe de langage visuel, l'interface est conforme à la DA mais pas
ergonomique. Trois griefs, dans l'ordre où l'utilisateur les a classés : on ne
sait pas où cliquer, on se perd, et il faut lâcher la radio pour naviguer. À quoi
s'ajoute une exigence explicite : **tout doit être faisable au clavier seul**.

Les mesures qui fondent ça sont dans #123 et ne sont pas répétées ici.

## Le principe directeur

Le modèle d'interaction n'est pas à inventer. Il a été écrit deux fois,
indépendamment — `session-log.js:106` et `target-scan.js:49` — avec les mêmes
touches : flèches pour déplacer un curseur, Entrée pour valider, Échap ou Retour
arrière pour remonter. `session-log.js:62` peint même déjà la sélection avec un
marqueur en tête de ligne.

**On extrait cette convention, on ne la remplace pas.** Tout écart par rapport à
ce que ces deux fichiers font déjà doit se justifier.

## Architecture

Le dépôt sépare partout un modèle pur, testable en Node, d'une coque DOM mince —
`hack-model.mjs` / `hack.js`, `terminal-model.mjs` / `terminal.js`,
`lib/weather.mjs` / `weather.js`. La navigation suit le même partage.

### `tools/menu-nav-model.mjs` — pur, Node-safe, aucun DOM

Toute la politique, donc tout ce qui peut se tromper :

- `intentFromKey(event) -> 'prev'|'next'|'side-'|'side+'|'back'|null`
- `intentFromPad(pad, prev, nowMs) -> même vocabulaire`, avec la répétition
  automatique : ~400 ms avant la première répétition, ~120 ms ensuite. C'est ce
  qui distingue un menu du CONTROL VECTOR, où une direction tenue ne doit
  produire qu'une seule saisie.
- `nextIndex(current, length, intent) -> index`, circulaire dans les deux sens,
  comme `session-log.js` le fait déjà. N'accepte que `'prev'` et `'next'` ;
  `'side±'` et `'back'` ne déplacent pas d'index et sont traités par la coque.

### `src/menu-nav.js` — la coque

```js
const nav = attachNav(container, {
  onBack,      // Échap · Retour arrière · manette B
  onSide,      // optionnel : gauche/droite quand ce n'est pas un réglage
  initial,     // élément à focaliser à l'ouverture (défaut : le premier)
  selector,    // défaut : 'button:not(:disabled), select, input, [data-nav]'
});
nav.refresh();   // après un re-render
nav.dispose();
```

Trois décisions portent le reste.

**Le module pilote le focus natif** (`element.focus()`), il ne tient pas de
curseur à lui. Conséquence : le curseur du jeu et le focus du navigateur ne
peuvent pas diverger, Tab et les flèches s'accordent gratuitement, et les aides
techniques suivent. C'est aussi ce qui fait disparaître l'anneau bleu système —
on le remplace, on ne l'ajoute pas.

**La validation au clavier n'est pas gérée du tout.** Un `<button>` focalisé
répond déjà à Entrée et à Espace. Le module ne s'occupe que des flèches, d'Échap,
et de la manette — pour laquelle il synthétise un `.click()`. Moins de code, et
aucun risque de double déclenchement.

**Un écran s'abonne explicitement.** C'est ce qui règle le conflit des flèches,
qui veulent dire trois choses selon le contexte :

| Contexte | Sens des flèches | S'abonne ? |
|---|---|---|
| `bootstrap.js:246` CONTROL VECTOR | direction-donnée | non |
| `ritual.js:19` saisie du hack | direction-donnée | non |
| `input.js` en vol | commande de vol | non |
| Menus | navigation | oui |

Deux garde-fous s'ajoutent, chacun corrigeant un bug qu'on aurait sinon :

- Les événements dont la cible est un `input` ou un `textarea` sont ignorés,
  sinon la recherche du scanner devient inéditable.
- Retour arrière ne remonte **jamais** depuis un champ texte, sinon on ne peut
  plus effacer un caractère.

**Gauche/droite est laissé au navigateur quand le contrôle focalisé est un
`input[type=range]` ou un `<select>`.** Le navigateur sait déjà régler ces
contrôles aux flèches ; ne rien faire est la bonne implémentation. `onSide` ne
sert qu'aux écrans où gauche/droite a un autre sens, comme le filtre de
`session-log`.

### Empilement

Une pile au niveau module : `attachNav` empile, `dispose` dépile, seul le sommet
répond. C'est ce qui fait que Settings ouvert par-dessus le terminal, ou le
scanner par-dessus la Home, ne reçoivent pas les touches en double. Un test
vérifie que la pile revient à vide — un abonnement non libéré est la panne la
plus probable de ce dessin.

### Manette

`gamepad-dir.js` lit déjà les directions et gère l'anti-répétition. Il gagne
`readGamepadButtons(prev)`, front montant sur le bouton 0 (valider) et le bouton
1 (revenir), dans le même style pur. Sondage en `requestAnimationFrame` tant
qu'un menu est attaché — jamais en vol, le module n'y est pas attaché.

## Ce qu'on voit à l'écran

**Le marqueur est `▌` (U+258C).** Vérifié natif dans Departure Mono : écart au
centre optique 0, pleine hauteur de cellule, encre collée au bord gauche — il
forme un filet vertical contre la rangée plutôt qu'un signe posé à côté.

Écartés, et pourquoi : `▸` et `▶` sont **absents** de la police (repli sur une
police système, donc chasse différente, donc cadres désalignés — le piège
documenté en PHASE 19) ; `*` flotte 6 px au-dessus du centre avec 63 % d'encre et
son glyphe porte déjà le sens « status » via le tag `[*]` de la Bible §40 ; `■`
est pris par `.verdict::before` dans `map-gui`.

C'est **le module qui pose la classe `.nav-item`** sur les éléments qu'il gère, à
l'abonnement et à chaque `refresh()`. Les écrans n'ont donc rien à baliser, et le
CSS n'a pas à connaître le markup de chacun d'eux :

```css
.nav-item::before { content: '\00a0'; display: inline-block; width: 1.2em; }
.nav-item:focus::before { content: '▌'; }
.nav-item:focus { outline: none; }
```

La gouttière est **réservée en permanence**, y compris non focalisée. Deux effets,
tous deux voulus : les rangées ne sautent pas quand le curseur se déplace, et un
élément actionnable est visiblement en retrait d'un texte qui ne l'est pas —
c'est la réponse au grief « on ne sait pas où cliquer », au repos et sans
survol.

`:focus` et non `:focus-visible` : le focus déplacé par la manette n'est pas
garanti de satisfaire l'heuristique de `:focus-visible`, et voir le curseur après
un clic souris est souhaitable de toute façon.

**Chaque écran focalise son premier élément à l'ouverture.** C'est le geste qui
fait que le curseur est toujours présent : on n'a jamais à deviner où l'on est,
ni à appuyer sur Tab pour commencer. Un écran qui veut focaliser autre chose —
la recherche du scanner — passe `initial`.

## Les deux réparations qui vont avec

**Les listes de `session-log` et `target-scan` deviennent de vrais boutons.**
Ce sont aujourd'hui des `<pre>` où le marqueur est écrit dans le texte : ni
cliquables, ni atteignables au Tab, ni lisibles par une aide technique. Sur
l'écran qui liste 142 sessions réelles, c'est le pire de l'ergonomie actuelle, et
c'est la condition pour que « tout au clavier » et « tout à la souris » soient
vrais en même temps. Leur `onKey` maison disparaît au profit du module — c'est
la vérification que l'extraction est fidèle.

**Le panneau Settings défile.** `max-height: calc(100vh - 2 * var(--space-5))` et
`overflow-y: auto`. Il fait 785 px et n'a aujourd'hui ni l'un ni l'autre : sur un
portable 1366×768 il est rogné en haut et en bas, sans recours.

## La Home

Le grief « on se perd » et le grief « on ne sait pas où cliquer » se rejoignent
ici. Les sept liens sont aujourd'hui sur deux rangées en ligne séparées par des
points médians, ce qui interdit une gouttière de marqueur par élément et ne dit
rien du regroupement.

Elle passe en **liste verticale**, dans l'ordre de ce qu'on fait le plus souvent.
`[ GLOBAL SCANNER ]` perd son cadre et son centrage : acquérir une zone est
l'action la plus rare, elle n'a pas à être le seul contrôle mis en avant. La Home
reste calme et sans cadre — Bible §30, « la Home ne doit pas devenir un
dashboard ».

Le compte de zones migre du pied de page vers la ligne `LOCAL TERRAIN`, où il
veut dire quelque chose.

## Vérification

- `tools/menu-nav-selftest.mjs` sur le modèle pur : correspondance touche →
  intention, répétition manette (une tenue produit 1 puis N après le délai),
  index circulaire, et la pile qui revient à vide.
- `npm run selftest` et `npm run selftest:operator` restent verts.
- Au navigateur, deux parcours complets de l'intro au vol : **un sans jamais
  toucher la souris**, **un sans jamais toucher le clavier** (manette seule).
  Ce sont les deux critères d'acceptation de #123 ; le reste est du détail.
- Vérifier qu'aucun anneau de focus bleu n'apparaît nulle part.
- Vérifier que le CONTROL VECTOR et le rituel acceptent toujours les flèches
  comme donnée — c'est la régression que ce travail peut provoquer.

## Point ouvert : sur quoi brancher

Ce travail **dépend de la PR #119** : le marqueur et le focus consomment les
jetons de `tokens.css`, qui n'existent pas sur `main`. Trois options :

1. Brancher sur `phase-19-visual-language` et empiler la PR — le travail peut
   commencer tout de suite, la relecture de #123 ne montre que l'ergonomie.
2. Merger #119 d'abord, puis brancher sur `main` — le plus simple à relire, mais
   il faut valider #119 à l'œil avant.
3. Tout mettre dans #119 — écarté, l'utilisateur a demandé une issue séparée.

Recommandation : **option 1**, en visant `main` une fois #119 mergée.
