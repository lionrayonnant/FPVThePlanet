// Authentification par clé d'opérateur — le mode `shared` (VPS).
//
// VIDE À DESSEIN. C'est la tranche T3 du design de déploiement
// (docs/superpowers/specs/2026-09-07-deploiement-double-mode-design.md) qui la
// remplira : secret de 128 bits rendu une seule fois à la création, stocké
// haché, envoyé en `Authorization: Bearer`, 401 sans clé, 403 avec une
// mauvaise, et `GET /__operator` qui rend 404 en `shared`.
//
// Le fichier existe dès maintenant parce que l'architecture cible le nomme, pas
// parce qu'il ferait quoi que ce soit : en T1 le serveur ne connaît qu'une
// frontière, le socket local (voir le garde-fou de `--host` dans index.mjs).

// Le mode `local` n'authentifie personne : la frontière est le socket.
export function requireOperatorKey() {
	return null;
}
