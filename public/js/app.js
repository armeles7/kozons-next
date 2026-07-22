import { supabase } from './supabase-client.js';
import { auth, profils, posts, commentaires, canaux, stories, notifications, messages, djassa, stockage, invaliderCacheListe } from './api.js';

/* ================= ÉTAT GLOBAL ================= */
const etat = {
  session: null,
  moi: null,          // profil de l'utilisateur connecté
  ecranActuel: 'accueil',
  filtreFil: 'TOUS',
  canalCourant: null,
  conversationCourante: null,
  abonnementRealtime: null,
  profilAffiche: null // id du profil consulté (autre que moi) sur l'écran profil
};

const EMOJIS = { JAIME:'👍', JADORE:'❤️', HAHA:'😂', WAOUH:'😮', TRISTE:'😢', GRRR:'😡' };

// Affiche une barre de progression pendant un upload et la retire une fois terminé.
// Retourne un callback onProgression à passer à stockage.televerser().
function creerBarreProgression(conteneur) {
  const barre = document.createElement('div');
  barre.className = 'upload-barre-fond';
  barre.innerHTML = '<div class="upload-barre-remplie"></div><span class="upload-barre-pct">0%</span>';
  conteneur.appendChild(barre);
  const remplie = barre.querySelector('.upload-barre-remplie');
  const pct = barre.querySelector('.upload-barre-pct');
  return {
    onProgression: (p) => { remplie.style.width = `${p}%`; pct.textContent = `${p}%`; },
    retirer: () => barre.remove()
  };
}

/* ================= UTILITAIRES ================= */
const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('cache');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('cache'), 2600);
}

function tempsRelatif(iso) {
  if (!iso) return '';
  const ms = /^\d+$/.test(String(iso)) ? Number(iso) : new Date(iso).getTime();
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} j`;
  return new Date(ms).toLocaleDateString('fr-FR');
}

function initiales(nom) {
  return (nom || '?').trim().split(/\s+/).map(m => m[0]).slice(0, 2).join('').toUpperCase();
}

function avatarHtml(url, nom, cls = 'avatar') {
  if (url) return `<img class="${cls}" src="${url}" alt="${nom || ''}">`;
  return `<div class="${cls}" style="display:flex;align-items:center;justify-content:center;background:var(--vert-clair);color:var(--vert-fonce);font-weight:700;font-size:.8rem;">${initiales(nom)}</div>`;
}

function ouvrirModale(html, url) {
  const dejaOuverte = !$('#modale').classList.contains('cache');
  $('#modale-contenu').innerHTML = html;
  $('#modale-contenu').classList.remove('story-viewer', 'creation-plein-ecran');
  $('#modale').classList.remove('cache');
  if (!dejaOuverte) history.pushState({ modale: true }, '', url);
}
function fermerModale(depuisPopstate) {
  $('#modale').classList.add('cache');
  if (!depuisPopstate && history.state?.modale) history.back();
}
$('#modale-fond').addEventListener('click', () => fermerModale());

/* ================= NAVIGATION ================= */
const ECRANS_IMMERSIFS = ['chat'];
const ECRANS_SANS_BARRE_HAUT = ['chat'];

function allerA(nomEcran, depuisPopstate, idEntite) {
  etat.ecranActuel = nomEcran;
  $$('.ecran').forEach(e => e.classList.add('cache'));
  const cible = $(`#ecran-${nomEcran}`);
  if (cible) cible.classList.remove('cache');
  $$('.nav-btn').forEach(b => b.classList.toggle('actif', b.dataset.ecran === nomEcran));

  const immersif = ECRANS_IMMERSIFS.includes(nomEcran);
  $('.barre-basse').classList.toggle('cache', immersif);
  $('.barre-haut').classList.toggle('cache', ECRANS_SANS_BARRE_HAUT.includes(nomEcran));
  $('.contenu').classList.toggle('contenu-immersif', immersif);

  if (!depuisPopstate) {
    const url = nomEcran === 'accueil' ? '/' : (idEntite ? `/${nomEcran}/${idEntite}` : `/${nomEcran}`);
    const state = { ecran: nomEcran, id: idEntite || null };
    if (history.state?.ecran) history.pushState(state, '', url);
    else history.replaceState(state, '', url);
  }

  if (nomEcran === 'accueil') chargerFil();
  else if (nomEcran === 'groupes') chargerCanaux('GROUPE');
  else if (nomEcran === 'pages') chargerCanaux('PAGE');
  else if (nomEcran === 'video') chargerVideos();
  else if (nomEcran === 'djassa') chargerDjassa();
  else if (nomEcran === 'notifications') chargerNotifications();
  else if (nomEcran === 'messages') chargerConversations();
  // 'profil', 'canal' et 'chat' sont pilotés par leurs fonctions dédiées
  // (ouvrirProfil / ouvrirCanal / ouvrirChat), qui appellent déjà allerA().
}

function ouvrirProfil(userId) {
  allerA('profil', false, userId === etat.moi.id ? null : userId);
  chargerProfil(userId);
}

function analyserChemin() {
  const segments = location.pathname.replace(/^\//, '').split('/').filter(Boolean);
  return { ecran: segments[0] || 'accueil', id: segments[1] || null };
}

// Bouton "retour" du navigateur / geste retour mobile : navigue entre les écrans
// de l'app au lieu de quitter le site.
window.addEventListener('popstate', (e) => {
  // Une modale ouverte (édition, story, partage...) se ferme en priorité, sans changer d'écran.
  if (!$('#modale').classList.contains('cache')) { fermerModale(true); return; }
  const cible = e.state?.ecran || 'accueil';
  const id = e.state?.id || null;
  if (cible === etat.ecranActuel && !id) return; // ex : on vient juste de fermer une modale, rien à recharger
  allerA(cible, true);
  if (cible === 'profil') chargerProfil(id || etat.moi.id);
  else if (cible === 'canal' && id) chargerContenuCanal(id);
  else if (cible === 'chat' && id) ouvrirChatParId(id);
});

$$('[data-ecran]').forEach(btn => btn.addEventListener('click', () => {
  if (btn.dataset.ecran === 'profil') ouvrirProfil(etat.moi.id);
  else allerA(btn.dataset.ecran);
}));
$$('[data-retour]').forEach(btn => btn.addEventListener('click', () => history.back()));

/* ================= AUTHENTIFICATION (Google uniquement, comme l'app) ================= */
$('#btn-google').addEventListener('click', async () => {
  const btn = $('#btn-google');
  btn.disabled = true;
  $('#auth-erreur').classList.add('cache');
  try {
    await auth.connexionGoogle();
  } catch (err) {
    $('#auth-erreur').textContent = err.message || "Connexion Google impossible.";
    $('#auth-erreur').classList.remove('cache');
  } finally {
    btn.disabled = false;
  }
});

async function demarrerSession(utilisateurFirebase) {
  etat.session = utilisateurFirebase;
  etat.moi = await profils.obtenir(utilisateurFirebase.uid);

  // Filet de sécurité contre une course avec la synchronisation du profil Google
  // (connexionGoogle() écrit nomComplet/avatarUrl dans Firestore, mais ce
  // démarrage de session peut se déclencher avant que cette écriture soit
  // terminée — sans ça, les posts/commentaires créés dans la foulée
  // héritent d'un nom vide). On utilise l'info déjà connue de Firebase Auth,
  // disponible immédiatement, sans attendre Firestore.
  if (!etat.moi.nomComplet && utilisateurFirebase.displayName) {
    etat.moi.nomComplet = utilisateurFirebase.displayName;
    etat.moi.nomComplet_lower = utilisateurFirebase.displayName.toLowerCase();
    if (!etat.moi.avatarUrl && utilisateurFirebase.photoURL) etat.moi.avatarUrl = utilisateurFirebase.photoURL;
    profils.modifier(etat.moi.id, {
      nomComplet: etat.moi.nomComplet, avatarUrl: etat.moi.avatarUrl || null
    }).catch(() => {});
  }

  // Stocker l'email Google dans le profil (nécessaire pour les notifications par email)
  if (utilisateurFirebase.email && !etat.moi.email) {
    profils.modifier(etat.moi.id, { email: utilisateurFirebase.email }).catch(() => {});
    etat.moi.email = utilisateurFirebase.email;
  }
  $('#app').classList.remove('cache');

  const { ecran, id } = analyserChemin();
  const NAVIGABLES_AU_DEMARRAGE = ['accueil', 'groupes', 'pages', 'video', 'djassa', 'notifications', 'recherche', 'messages'];
  if (ecran === 'profil' && id) ouvrirProfil(id);
  else if (ecran === 'canal' && id) ouvrirCanal(id);
  else if (ecran === 'chat' && id) { allerA('chat', false, id); ouvrirChatParId(id); }
  else if (ecran === 'post') allerA('accueil'); // le post lui-même s'ouvre par-dessus juste après (ouvrirLienPartage)
  else if (NAVIGABLES_AU_DEMARRAGE.includes(ecran) || ecran === 'profil') allerA(ecran);
  else allerA('accueil');

  rafraichirBadges();
  demarrerEcouteNotifications();
  proposerNotificationsSysteme();

  // Badge messages mis à jour en temps réel (comme les notifications)
  if (etat.abonnementMessages) etat.abonnementMessages();
  etat.abonnementMessages = messages.ecouterNonLus(etat.moi.id, (total) => {
    $('#badge-messages').textContent = total;
    $('#badge-messages').classList.toggle('cache', !total);
  });
  profils.marquerPresence(etat.moi.id).catch(() => {});
  if (etat.intervalPresence) clearInterval(etat.intervalPresence);
  etat.intervalPresence = setInterval(() => profils.marquerPresence(etat.moi.id).catch(() => {}), 2 * 60 * 1000);
}

function arreterSession() {
  etat.session = null; etat.moi = null;
  if (etat.intervalPresence) clearInterval(etat.intervalPresence);
  if (etat.abonnementNotifs) { etat.abonnementNotifs(); etat.abonnementNotifs = null; }
  if (etat.abonnementMessages) { etat.abonnementMessages(); etat.abonnementMessages = null; }
  $('#app').classList.add('cache');
  $('#ecran-auth').classList.remove('cache');
}

async function rafraichirBadges() {
  // Les deux badges (notifs + messages) sont maintenant gérés en temps réel
  // via demarrerEcouteNotifications() et messages.ecouterNonLus(). Cette fonction
  // n'a plus besoin de faire de requête initiale.
}

/* ================= ACCUEIL / FIL ================= */
$$('.filtre-btn').forEach(btn => btn.addEventListener('click', () => {
  etat.filtreFil = btn.dataset.filtre;
  $$('.filtre-btn').forEach(b => b.classList.toggle('actif', b === btn));
  chargerFil();
}));

let fichiersComposerChoisis = [];
let couleurComposerChoisie = '#1E9E4A';
let blobAudioComposer = null;
let enregistreurComposer = null;
let chronoComposer = null;

$('#composer-type').addEventListener('change', (e) => {
  const type = e.target.value;
  const champFichier = $('#composer-fichier');
  fichiersComposerChoisis = [];
  blobAudioComposer = null;
  champFichier.value = '';
  $('#composer-apercu').classList.add('cache');
  $('#composer-apercu').innerHTML = '';
  $('#composer-couleurs').classList.toggle('cache', type !== 'COULEUR');
  $('#composer-fichier-note').classList.toggle('cache', type !== 'IMAGE');
  $('#composer-audio-zone').classList.toggle('cache', type !== 'AUDIO');
  $('#composer-audio-btn').textContent = '🔴 Enregistrer';
  $('#composer-audio-chrono').classList.add('cache');
  if (type === 'IMAGE' || type === 'VIDEO') {
    champFichier.accept = type === 'IMAGE' ? 'image/*' : 'video/*';
    champFichier.multiple = type === 'IMAGE';
    champFichier.classList.remove('cache');
    champFichier.click();
  } else {
    champFichier.classList.add('cache');
  }
});

$('#composer-audio-btn').addEventListener('click', async () => {
  const btn = $('#composer-audio-btn');
  const chrono = $('#composer-audio-chrono');
  if (!enregistreurComposer) {
    try {
      enregistreurComposer = creerEnregistreurAudio();
      await enregistreurComposer.demarrer();
      btn.textContent = '⏹️ Arrêter'; btn.classList.add('bouton-secondaire');
      chrono.classList.remove('cache');
      const debut = Date.now();
      chronoComposer = setInterval(() => chrono.textContent = formatDuree(Date.now() - debut), 500);
    } catch { toast("Impossible d'accéder au micro."); enregistreurComposer = null; }
  } else {
    clearInterval(chronoComposer);
    const { blob, dureeMs } = await enregistreurComposer.arreter();
    enregistreurComposer = null;
    blobAudioComposer = blob;
    blobAudioComposer.dureeMs = dureeMs;
    btn.textContent = '🔄 Recommencer';
    const zone = $('#composer-apercu');
    zone.innerHTML = htmlLecteurAudio(URL.createObjectURL(blob), dureeMs);
    zone.classList.remove('cache');
    brancherLecteursAudio(zone);
  }
});

$$('.pastille-couleur').forEach(btn => btn.addEventListener('click', () => {
  couleurComposerChoisie = btn.dataset.couleur;
  $$('.pastille-couleur').forEach(b => b.classList.toggle('actif', b === btn));
}));

function rafraichirApercuComposer() {
  const type = $('#composer-type').value;
  const zone = $('#composer-apercu');
  if (!fichiersComposerChoisis.length) { zone.classList.add('cache'); zone.innerHTML = ''; return; }
  zone.classList.remove('cache');
  if (type === 'VIDEO') {
    const url = URL.createObjectURL(fichiersComposerChoisis[0]);
    zone.innerHTML = `<video src="${url}" controls></video><button type="button" class="apercu-retirer" id="composer-apercu-retirer-0">✕</button>`;
    $('#composer-apercu-retirer-0').addEventListener('click', () => { fichiersComposerChoisis = []; rafraichirApercuComposer(); });
    return;
  }
  zone.innerHTML = `<div class="carrousel-apercu">
    ${fichiersComposerChoisis.map((f, i) => `
      <div class="carrousel-apercu-item">
        <img src="${URL.createObjectURL(f)}">
        <span class="carrousel-position">${i + 1}/${fichiersComposerChoisis.length}</span>
        <button type="button" class="apercu-retirer" data-i="${i}">✕</button>
      </div>`).join('')}
    <button type="button" class="carrousel-ajouter" id="composer-ajouter-photo">+ Ajouter</button>
  </div>`;
  $$('.apercu-retirer', zone).forEach(b => b.addEventListener('click', () => {
    fichiersComposerChoisis.splice(Number(b.dataset.i), 1);
    rafraichirApercuComposer();
  }));
  $('#composer-ajouter-photo')?.addEventListener('click', () => $('#composer-fichier').click());
}

$('#composer-fichier').addEventListener('change', (e) => {
  const nouveaux = [...e.target.files];
  if (!nouveaux.length) return;
  const type = $('#composer-type').value;
  fichiersComposerChoisis = type === 'VIDEO' ? [nouveaux[0]] : [...fichiersComposerChoisis, ...nouveaux].slice(0, 10);
  e.target.value = '';
  rafraichirApercuComposer();
});

$('#composer-publier').addEventListener('click', async () => {
  const texte = $('#composer-texte').value.trim();
  const type = $('#composer-type').value;
  if (!texte && !fichiersComposerChoisis.length && !blobAudioComposer) return toast('Écris quelque chose ou ajoute un contenu.');
  const btn = $('#composer-publier');
  btn.disabled = true;
  const texteInitial = btn.textContent;
  try {
    let mediaUrl = null;
    let medias = null;
    if (type === 'AUDIO' && blobAudioComposer) {
      btn.textContent = 'Envoi...';
      const { onProgression, retirer } = creerBarreProgression($('#composer'));
      mediaUrl = await stockage.televerser(blobAudioComposer, 'posts', onProgression);
      retirer();
    } else if (fichiersComposerChoisis.length) {
      if (type === 'IMAGE' && fichiersComposerChoisis.length > 1) {
        const urls = [];
        for (let i = 0; i < fichiersComposerChoisis.length; i++) {
          btn.textContent = `Envoi ${i + 1}/${fichiersComposerChoisis.length}`;
          const { onProgression, retirer } = creerBarreProgression($('#composer'));
          urls.push(await stockage.televerser(fichiersComposerChoisis[i], 'posts', onProgression));
          retirer();
        }
        mediaUrl = urls[0];
        medias = urls.map((url, position) => ({ url, typeMedia: 'IMAGE', position }));
      } else {
        btn.textContent = 'Envoi...';
        const { onProgression, retirer } = creerBarreProgression($('#composer'));
        mediaUrl = await stockage.televerser(fichiersComposerChoisis[0], 'posts', onProgression);
        retirer();
      }
    }
    await posts.publier({
      auteurId: etat.moi.id, auteurNom: etat.moi.nomComplet, auteurAvatar: etat.moi.avatarUrl,
      texte, typeMedia: (fichiersComposerChoisis.length || blobAudioComposer) ? type : 'TEXTE', mediaUrl, medias,
      dureeAudioMs: type === 'AUDIO' ? blobAudioComposer?.dureeMs : null,
      couleurFond: (type === 'COULEUR' && !fichiersComposerChoisis.length) ? couleurComposerChoisie : null,
      channelId: etat.canalCourant?.id, channelNom: etat.canalCourant?.nom
    });
    $('#composer-texte').value = '';
    $('#composer-fichier').value = ''; $('#composer-fichier').classList.add('cache');
    $('#composer-apercu').classList.add('cache'); $('#composer-apercu').innerHTML = '';
    $('#composer-couleurs').classList.add('cache');
    $('#composer-fichier-note').classList.add('cache');
    $('#composer-audio-zone').classList.add('cache');
    $('#composer-audio-btn').textContent = '🔴 Enregistrer';
    $('#composer-audio-chrono').classList.add('cache');
    $('#composer-type').value = 'TEXTE';
    fichiersComposerChoisis = [];
    blobAudioComposer = null;
    toast('Publié !');
    if (etat.canalCourant) ouvrirCanal(etat.canalCourant.id); else chargerFil();
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = texteInitial; }
});

let _storiesEnChargement = false;
async function chargerStories() {
  if (_storiesEnChargement) return;
  _storiesEnChargement = true;
  const barre = $('#stories-barre');
  const bulleAjout = `
    <div class="grande-carte carte-creer carte-creer-story" id="story-ajouter">
      <span class="carte-creer-icone">+</span>
      <span class="carte-creer-texte">Créer une<br>story</span>
    </div>`;
  barre.innerHTML = bulleAjout;
  $('#story-ajouter').addEventListener('click', ouvrirCreationStory);
  try {
    const data = await stories.actives();
    if (!data.length) { _storiesEnChargement = false; return; }
    const parAuteur = new Map();
    data.forEach(s => {
      if (!parAuteur.has(s.auteurId)) parAuteur.set(s.auteurId, []);
      parAuteur.get(s.auteurId).push(s);
    });
    const groupes = [...parAuteur.values()];
    // On repart d'une barre propre avant d'insérer pour éviter les doublons
    barre.innerHTML = bulleAjout;
    $('#story-ajouter').addEventListener('click', ouvrirCreationStory);
    barre.insertAdjacentHTML('beforeend', groupes.map((g, i) => {
      const s = g[0];
      const toutesVues = g.every(x => x.vue_par_moi);
      const fond = s.media_url ? `style="background-image:url('${s.media_url}')"` : `style="background:${s.couleurFond || '#1E9E4A'}"`;
      return `
      <div class="grande-carte carte-story ${toutesVues ? 'vue' : ''}" data-groupe="${i}" ${fond}>
        <div class="carte-avatar">${avatarHtml(s.auteur_avatar, s.auteur_nom, '')}</div>
        <span class="carte-nom">${s.auteur_id === etat.moi.id ? 'Toi' : s.auteur_nom.split(' ')[0]}</span>
      </div>`;
    }).join(''));
    $$('.carte-story', barre).forEach(el => el.addEventListener('click', () => ouvrirVisionneuseStories(groupes, Number(el.dataset.groupe))));
  } catch { /* la carte "créer" reste affichée même en cas d'erreur réseau */ }
  finally { _storiesEnChargement = false; }
}

async function chargerReels() {
  const barre = $('#reels-barre');
  const bulleAjout = `
    <div class="grande-carte carte-creer carte-creer-reel" id="reel-ajouter">
      <span class="carte-creer-icone">📹+</span>
      <span class="carte-creer-texte">Créer un<br>reel</span>
    </div>`;
  barre.innerHTML = bulleAjout;
  $('#reel-ajouter').addEventListener('click', ouvrirCreationReel);
  try {
    const data = await stories.reelsActifs();
    if (!data.length) return;
    const parAuteur = new Map();
    data.forEach(s => {
      if (!parAuteur.has(s.auteurId)) parAuteur.set(s.auteurId, []);
      parAuteur.get(s.auteurId).push(s);
    });
    const groupes = [...parAuteur.values()];
    // Repartir d'une barre propre avant d'insérer pour éviter les doublons
    barre.innerHTML = bulleAjout;
    $('#reel-ajouter').addEventListener('click', ouvrirCreationReel);
    barre.insertAdjacentHTML('beforeend', groupes.map((g, i) => {
      const s = g[0];
      return `
      <div class="grande-carte carte-reel" data-groupe="${i}">
        ${s.typeMedia === 'IMAGE' ? `<img src="${s.mediaUrl}">` : `<video src="${s.mediaUrl}" muted playsinline preload="metadata"></video>`}
        <div class="carte-avatar">${avatarHtml(s.auteurAvatar, s.auteurNom, '')}</div>
        <span class="carte-nom">${s.auteurId === etat.moi.id ? 'Toi' : s.auteurNom.split(' ')[0]}</span>
      </div>`;
    }).join(''));
    $$('.carte-reel', barre).forEach(el => el.addEventListener('click', () => ouvrirVisionneuseStories(groupes, Number(el.dataset.groupe))));
  } catch { /* la carte "créer" reste affichée même en cas d'erreur réseau */ }
}

function ouvrirCreationReel() {
  const contenu = $('#modale-contenu');
  ouvrirModale(`
    <div class="creation-entete">
      <button type="button" class="creation-fermer" id="reel-fermer">✕</button>
      <b>Capturez un Reel</b>
      <button type="button" class="creation-publier" id="reel-publier-btn" disabled>Publier</button>
    </div>
    <div id="reel-corps"></div>`);
  contenu.classList.add('creation-plein-ecran');
  $('#reel-fermer').addEventListener('click', fermerModale);

  let fichierChoisi = null;

  function afficherChoix() {
    $('#reel-corps').innerHTML = `
      <p class="creation-question">Choisissez un mode de capture</p>
      <div class="creation-options">
        <div class="creation-option" id="reel-choix-photo">
          <div class="creation-icone creation-icone-vert">📷</div>
          <span>Photo</span>
        </div>
        <div class="creation-option" id="reel-choix-video">
          <div class="creation-icone creation-icone-rouge">🎥</div>
          <span>Vidéo</span>
        </div>
      </div>
      <p class="creation-note">Le mode texte est désormais disponible dans "Créer une Story"</p>
      <input type="file" id="reel-fichier" class="cache" capture="environment">`;
    const champFichier = $('#reel-fichier');
    $('#reel-choix-photo').addEventListener('click', () => {
      champFichier.accept = 'image/*';
      champFichier.setAttribute('capture', 'environment');
      champFichier.click();
    });
    $('#reel-choix-video').addEventListener('click', () => {
      champFichier.accept = 'video/*';
      champFichier.setAttribute('capture', 'environment');
      champFichier.click();
    });
    champFichier.addEventListener('change', (e) => {
      const fichier = e.target.files[0];
      if (!fichier) return;
      fichierChoisi = fichier;
      afficherApercu();
    });
  }

  function afficherApercu() {
    const url = URL.createObjectURL(fichierChoisi);
    const estVideo = fichierChoisi.type.startsWith('video');
    $('#reel-corps').innerHTML = `
      <div class="creation-apercu-media">${estVideo ? `<video src="${url}" controls></video>` : `<img src="${url}">`}</div>
      <textarea id="reel-texte" placeholder="Une légende ? (optionnel)" rows="2" class="creation-textarea"></textarea>`;
    $('#reel-publier-btn').disabled = false;
  }

  afficherChoix();

  $('#reel-publier-btn').addEventListener('click', async () => {
    if (!fichierChoisi) return toast('Choisis une photo ou une vidéo.');
    const btn = $('#reel-publier-btn');
    btn.disabled = true; const texteInitial = btn.textContent;
    try {
      btn.textContent = 'Envoi...';
      const typeMedia = fichierChoisi.type.startsWith('video') ? 'VIDEO' : 'IMAGE';
      const { onProgression, retirer } = creerBarreProgression($('#modale-contenu'));
      const mediaUrl = await stockage.televerser(fichierChoisi, 'reels', onProgression);
      retirer();
      await stories.publierReel({
        auteurId: etat.moi.id, auteurNom: etat.moi.nomComplet, auteurAvatar: etat.moi.avatarUrl,
        typeMedia, mediaUrl, texte: $('#reel-texte').value.trim()
      });
      fermerModale();
      toast('Reel publié !');
      chargerReels();
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = texteInitial; }
  });
}

function ouvrirCreationStory() {
  const contenu = $('#modale-contenu');
  ouvrirModale(`
    <div class="creation-entete">
      <button type="button" class="creation-fermer" id="story-fermer">✕</button>
      <b>Nouvelle story</b>
      <button type="button" class="creation-publier" id="story-publier-btn" disabled>Publier</button>
    </div>
    <div id="story-corps"></div>`);
  contenu.classList.add('creation-plein-ecran');
  $('#story-fermer').addEventListener('click', fermerModale);

  let couleurStory = '#1E9E4A';
  let fichierChoisi = null;

  function afficherChoix() {
    $('#story-corps').innerHTML = `
      <p class="creation-question">Que veux-tu partager ?</p>
      <div class="creation-options">
        <div class="creation-option" id="story-choix-media">
          <div class="creation-icone creation-icone-bleu">🖼️</div>
          <span>Photo / Vidéo</span>
        </div>
        <div class="creation-option" id="story-choix-texte">
          <div class="creation-icone creation-icone-vert">Tt</div>
          <span>Texte</span>
        </div>
      </div>
      <input type="file" id="story-fichier" accept="image/*,video/*" class="cache">`;
    $('#story-choix-media').addEventListener('click', () => $('#story-fichier').click());
    $('#story-fichier').addEventListener('change', (e) => {
      const fichier = e.target.files[0];
      if (!fichier) return;
      fichierChoisi = fichier;
      afficherEtapeMedia();
    });
    $('#story-choix-texte').addEventListener('click', afficherEtapeTexte);
  }

  function afficherEtapeMedia() {
    const url = URL.createObjectURL(fichierChoisi);
    const estVideo = fichierChoisi.type.startsWith('video');
    $('#story-corps').innerHTML = `
      <div class="creation-apercu-media">${estVideo ? `<video src="${url}" controls></video>` : `<img src="${url}">`}</div>
      <textarea id="story-texte" placeholder="Ajouter une légende... (optionnel)" rows="2" class="creation-textarea"></textarea>`;
    $('#story-publier-btn').disabled = false;
  }

  function afficherEtapeTexte() {
    $('#story-corps').innerHTML = `
      <div class="composer-couleurs" id="story-couleurs" style="justify-content:center;margin:16px 0;">
        <button type="button" class="pastille-couleur actif" data-couleur="#1E9E4A" style="background:#1E9E4A"></button>
        <button type="button" class="pastille-couleur" data-couleur="#FF6F61" style="background:#FF6F61"></button>
        <button type="button" class="pastille-couleur" data-couleur="#2563EB" style="background:#2563EB"></button>
        <button type="button" class="pastille-couleur" data-couleur="#D32F2F" style="background:#D32F2F"></button>
        <button type="button" class="pastille-couleur" data-couleur="#7C3AED" style="background:#7C3AED"></button>
        <button type="button" class="pastille-couleur" data-couleur="#111827" style="background:#111827"></button>
      </div>
      <textarea id="story-texte" placeholder="Écris quelque chose..." rows="3" class="creation-textarea" style="background:${couleurStory};color:#fff;text-align:center;font-weight:700;font-size:1.2rem;"></textarea>`;
    $$('#story-couleurs .pastille-couleur').forEach(btn => btn.addEventListener('click', () => {
      couleurStory = btn.dataset.couleur;
      $$('#story-couleurs .pastille-couleur').forEach(b => b.classList.toggle('actif', b === btn));
      $('#story-texte').style.background = couleurStory;
    }));
    $('#story-texte').addEventListener('input', () => {
      $('#story-publier-btn').disabled = !$('#story-texte').value.trim();
    });
  }

  afficherChoix();

  $('#story-publier-btn').addEventListener('click', async () => {
    const texte = $('#story-texte')?.value.trim() || '';
    if (!texte && !fichierChoisi) return toast('Ajoute une photo/vidéo ou un texte.');
    const btn = $('#story-publier-btn');
    btn.disabled = true; const texteInitial = btn.textContent;
    try {
      let mediaUrl = null, typeMedia = 'IMAGE';
      if (fichierChoisi) {
        btn.textContent = 'Envoi...';
        typeMedia = fichierChoisi.type.startsWith('video') ? 'VIDEO' : 'IMAGE';
        const { onProgression, retirer } = creerBarreProgression($('#modale-contenu'));
        mediaUrl = await stockage.televerser(fichierChoisi, 'stories', onProgression);
        retirer();
      }
      await stories.publier({
        auteurId: etat.moi.id, auteurNom: etat.moi.nomComplet, auteurAvatar: etat.moi.avatarUrl,
        typeMedia, mediaUrl, texte, couleurFond: !fichierChoisi ? couleurStory : null
      });
      fermerModale();
      toast('Story publiée !');
      chargerStories();
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = texteInitial; }
  });
}

// Affiche une liste de profils (vues ou likes) dans un petit panel
// par-dessus la visionneuse de story, sans la fermer.
function _ouvrirListeStory(liste, titre, msgVide) {
  const modale = $('#modale-contenu');
  const panelExistant = $('#story-liste-panel');
  if (panelExistant) { panelExistant.remove(); return; }
  const panel = document.createElement('div');
  panel.id = 'story-liste-panel';
  panel.className = 'story-liste-panel';
  panel.innerHTML = `
    <div class="story-liste-entete">
      <b>${titre}</b>
      <button class="story-fermer" id="story-liste-fermer">✕</button>
    </div>
    <div class="story-liste-corps">
      ${liste.length ? liste.map(p => `
        <div class="canal-carte story-liste-item" data-uid="${p.id}">
          ${avatarHtml(p.avatarUrl, p.nomComplet, 'avatar avatar-sm')}
          <div class="canal-infos"><div class="canal-nom">${p.nomComplet || 'Utilisateur'}</div></div>
        </div>`).join('') : `<p class="vide">${msgVide}</p>`}
    </div>`;
  modale.appendChild(panel);
  $('#story-liste-fermer').addEventListener('click', () => panel.remove());
  $$('.story-liste-item', panel).forEach(el => el.addEventListener('click', () => {
    panel.remove(); fermerModale(); ouvrirProfil(el.dataset.uid);
  }));
}

function ouvrirVisionneuseStories(groupes, indexGroupeDepart) {
  let ig = indexGroupeDepart, is = 0, minuteur = null, enPause = false, debutSegment = 0;
  ouvrirModale('');
  const contenu = $('#modale-contenu');
  contenu.classList.add('story-viewer');

  function fermer() { clearInterval(minuteur); fermerModale(); }

  function segments() {
    return groupes[ig].map(() => `<div class="story-segment"><div class="story-segment-remplie"></div></div>`).join('');
  }
  function marquerSegments() {
    $$('.story-segment-remplie', contenu).forEach((el, i) => {
      el.style.width = i < is ? '100%' : i === is ? '0%' : '0%';
    });
  }

  function suivant() {
    clearInterval(minuteur);
    if (is < groupes[ig].length - 1) { is++; rendre(); }
    else if (ig < groupes.length - 1) { ig++; is = 0; rendre(); }
    else fermer();
  }
  function precedent() {
    clearInterval(minuteur);
    if (is > 0) { is--; rendre(); }
    else if (ig > 0) { ig--; is = groupes[ig].length - 1; rendre(); }
    else rendre();
  }

  function demarrerProgression(dureeMs) {
    clearInterval(minuteur);
    const segEl = $$('.story-segment-remplie', contenu)[is];
    debutSegment = Date.now();
    minuteur = setInterval(() => {
      if (enPause) { debutSegment += 100; return; }
      const pct = Math.min(100, ((Date.now() - debutSegment) / dureeMs) * 100);
      if (segEl) segEl.style.width = pct + '%';
      if (pct >= 100) suivant();
    }, 100);
  }

  function rendre() {
    const s = groupes[ig][is];
    stories.marquerVue(s.id, etat.moi.id).catch(() => {});
    const estMoi = s.auteurId === etat.moi.id;
    const fondCouleur = !s.mediaUrl && s.couleurFond ? `background:${s.couleurFond};` : '';
    const media = s.typeMedia === 'VIDEO' && s.mediaUrl ? `<video src="${s.mediaUrl}" autoplay playsinline muted></video>`
      : s.mediaUrl ? `<img src="${s.mediaUrl}">` : '';

    contenu.innerHTML = `
      <div class="story-segments">${segments()}</div>
      <div class="story-entete">
        ${avatarHtml(s.auteurAvatar, s.auteurNom, 'avatar avatar-sm')}
        <b>${estMoi ? 'Toi' : s.auteurNom}</b>
        <span class="story-temps">${tempsRelatif(s.dateCreation)}</span>
        <button type="button" class="story-fermer" id="story-fermer">✕</button>
      </div>
      <div class="story-media" style="${fondCouleur}">
        ${media}
        ${!s.mediaUrl && s.texte ? `<p class="story-texte-seul">${escHtml(s.texte)}</p>` : ''}
      </div>
      ${s.mediaUrl && s.texte ? `<p class="story-legende">${escHtml(s.texte)}</p>` : ''}
      <div class="story-tap-zone"></div>
      ${estMoi ? `
      <div class="story-barre-bas">
        <button type="button" class="story-stat story-stat-btn" id="story-btn-vues">👁 ${s.nbVues || 0} vue(s)</button>
        <button type="button" class="story-stat story-stat-btn" id="story-btn-likes">❤️ ${s.nbLikes || 0}</button>
        <button type="button" class="story-suppr-btn" title="Supprimer">🗑️</button>
      </div>` : `
      <div class="story-barre-bas">
        <form class="story-repondre-form">
          <input type="text" placeholder="Répondre">
          <button type="button" data-emoji="😍" class="story-emoji-btn">😍</button>
          <button type="button" data-emoji="😂" class="story-emoji-btn">😂</button>
          <button type="button" data-emoji="😮" class="story-emoji-btn">😮</button>
          <button type="button" class="story-like-btn">🤍</button>
        </form>
      </div>`}`;

    marquerSegments();
    $('#story-fermer', contenu).addEventListener('click', fermer);

    if (estMoi) {
      $('#story-btn-vues', contenu).addEventListener('click', async () => {
        enPause = true;
        try {
          const liste = await stories.listerVues(s.id);
          _ouvrirListeStory(liste, '👁 Vues', 'Personne n\'a encore vu cette story.');
        } catch (err) { toast(err.message); }
        enPause = false;
      });
      $('#story-btn-likes', contenu).addEventListener('click', async () => {
        enPause = true;
        try {
          const liste = await stories.listerLikes(s.id);
          _ouvrirListeStory(liste, '❤️ J\'aime', 'Personne n\'a encore aimé cette story.');
        } catch (err) { toast(err.message); }
        enPause = false;
      });
      $('.story-suppr-btn', contenu).addEventListener('click', async () => {
        enPause = true;
        if (!confirm('Supprimer cette story ?')) { enPause = false; return; }
        try {
          await stories.supprimerStory(s.id);
          toast('Story supprimée');
          groupes[ig].splice(is, 1);
          if (!groupes[ig].length) groupes.splice(ig, 1);
          chargerStories();
          if (!groupes.length) return fermer();
          if (ig >= groupes.length) ig = groupes.length - 1;
          if (is >= groupes[ig].length) is = groupes[ig].length - 1;
          rendre();
        } catch (err) { toast(err.message); enPause = false; }
      });
    } else {
      async function envoyerReponseStory(texte) {
        enPause = true;
        try {
          const convId = await messages.ouvrirAvec(s.auteurId);
          await messages.envoyer({
            conversationId: convId, expediteurId: etat.moi.id, texte,
            storyId: s.id, storyApercu: s.mediaUrl || null, storyTypeMedia: s.typeMedia
          });
          toast('Envoyé 👍');
        } catch (err) { toast(err.message); }
        enPause = false;
      }

      // Emojis rapides → inbox
      $$('.story-emoji-btn', contenu).forEach(btn =>
        btn.addEventListener('click', () => envoyerReponseStory(btn.dataset.emoji))
      );

      // Like ❤️
      $('.story-like-btn', contenu).addEventListener('click', async (e) => {
        try {
          await stories.aimer(s.id, etat.moi.id);
          e.target.textContent = '❤️';
          toast('❤️');
        } catch (err) { toast(err.message); }
      });

      // Champ texte → inbox avec aperçu
      const formReponse = $('.story-repondre-form', contenu);
      $('input', formReponse)?.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const texte = e.target.value.trim();
        if (!texte) return;
        e.target.value = '';
        envoyerReponseStory(texte);
      });
      const btnEnvoyer = $('button[type="submit"]', formReponse);
      if (btnEnvoyer) btnEnvoyer.addEventListener('click', () => {
        const input = $('input', formReponse);
        const texte = input.value.trim();
        if (!texte) return;
        input.value = '';
        envoyerReponseStory(texte);
      });
    }

    // Geste : tap gauche/droite = navigation, appui maintenu = pause
    const zone = $('.story-tap-zone', contenu);
    let minuteurAppui = null, futAppuiLong = false;
    zone.addEventListener('pointerdown', (e) => {
      futAppuiLong = false;
      minuteurAppui = setTimeout(() => { futAppuiLong = true; enPause = true; }, 250);
    });
    const relacher = (e) => {
      clearTimeout(minuteurAppui);
      if (futAppuiLong) { enPause = false; return; }
      const moitieDroite = (e.clientX - zone.getBoundingClientRect().left) > zone.clientWidth / 2;
      moitieDroite ? suivant() : precedent();
    };
    zone.addEventListener('pointerup', relacher);
    zone.addEventListener('pointerleave', () => { enPause = false; clearTimeout(minuteurAppui); });

    const video = $('video', contenu);
    if (video) {
      video.addEventListener('loadedmetadata', () => demarrerProgression((video.duration || 8) * 1000));
    } else {
      demarrerProgression(5000);
    }

  }

  rendre();
}

async function chargerFil() {
  const liste = $('#fil-liste');
  liste.innerHTML = '<p class="vide">Chargement du fil...</p>';
  chargerStories();
  chargerReels();
  try {
    const data = await posts.fil(etat.filtreFil, 20, 0);
    renderFil(liste, data);
    // Suggestions toujours présentes : en bas du fil s'il y a des posts,
    // ou à la place du message vide pour les nouveaux utilisateurs
    insererSuggestions(liste);
  } catch (err) {
    liste.innerHTML = `<p class="vide">Impossible de charger le fil : ${err.message}</p>`;
  }
}

async function insererSuggestions(conteneur) {
  try {
    const sugg = await profils.suggestions(etat.moi.id, 6);
    if (!sugg.length) return;
    const bloc = document.createElement('div');
    bloc.className = 'suggestions-bloc';
    bloc.innerHTML = `
      <h3 class="sous-titre" style="margin-top:0;">Personnes que vous pourriez connaître</h3>
      <div class="suggestions-liste">
        ${sugg.map(p => `
          <div class="suggestion-carte" data-uid="${p.id}">
            ${avatarHtml(p.avatarUrl, p.nomComplet, 'avatar')}
            <span class="suggestion-nom">${p.nomComplet || 'Utilisateur'}</span>
            <button class="bouton bouton-principal bouton-sm btn-suivre-suggestion">Suivre</button>
          </div>`).join('')}
      </div>`;
    const posts_ = $$('.post-carte', conteneur);
    if (posts_.length >= 3) posts_[2].after(bloc); else conteneur.appendChild(bloc);
    $$('.suggestion-carte', bloc).forEach(carte => {
      const uid = carte.dataset.uid;
      carte.addEventListener('click', () => { ouvrirProfil(uid); });
      carte.querySelector('.btn-suivre-suggestion').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await profils.suivre(etat.moi.id, uid);
          e.target.textContent = 'Suivi ✓'; e.target.disabled = true;
        } catch (err) { toast(err.message); }
      });
    });
  } catch { /* silencieux : les suggestions ne sont pas critiques */ }
}

function renderFil(conteneur, data) {
  if (!data.length) {
    conteneur.innerHTML = `
      <div class="fil-vide-bienvenue">
        <p>👋 Bienvenue sur KoZons !</p>
        <p style="font-size:.9rem;color:var(--texte-att);">Ton fil est vide pour l'instant.<br>Abonne-toi à des personnes ou rejoins des groupes pour voir leurs publications ici.</p>
      </div>`;
    return;
  }
  conteneur.innerHTML = data.map(carteRost => cartePost(carteRost)).join('');
  $$('.post-carte', conteneur).forEach(carte => brancherPost(carte, data.find(p => p.id === carte.dataset.id)));
  brancherVideosImmersives(conteneur);
  brancherCarrousels(conteneur);
  brancherLecteursAudio(conteneur);
}

function cartePost(p) {
  const media = p.typeMedia === 'IMAGE' && p.medias?.length > 1 ? `<div class="post-media">${htmlCarrouselPost(p.medias)}</div>`
    : p.typeMedia === 'IMAGE' && p.mediaUrl ? `<div class="post-media"><img src="${p.mediaUrl}"></div>`
    : p.typeMedia === 'VIDEO' && p.mediaUrl ? `<div class="post-media">${htmlVideoImmersif(p.mediaUrl)}</div>`
    : p.typeMedia === 'AUDIO' && p.mediaUrl ? `<div class="post-media">${htmlLecteurAudio(p.mediaUrl, p.dureeAudioMs)}</div>` : '';
  const estColore = p.couleurFond && !p.mediaUrl;
  const corpsTexte = estColore
    ? `<div class="post-texte-couleur" style="background:${p.couleurFond}">${escHtml(p.texte)}</div>`
    : (p.texte ? `<p class="post-texte">${texteAvecMentions(p.texte)}</p>` : '');
  const estProprietaire = p.auteurId === etat.moi?.id;
  return `
  <article class="post-carte ${estColore ? 'post-colore' : ''}" data-id="${p.id}">
    <div class="post-entete">
      <div class="post-auteur-lien" data-auteur="${p.auteurId}">${avatarHtml(p.auteurAvatar, p.auteurNom)}</div>
      <div>
        <div class="post-auteur">
          <span class="post-auteur-lien" data-auteur="${p.auteurId}">${p.auteurNom}</span>
          ${p.channelNom ? ` <span class="post-canal-lien" data-canal="${p.channelId}" style="color:var(--texte-att);font-weight:400;">→ ${p.channelNom}</span>` : ''}
        </div>
        <div class="post-meta">${tempsRelatif(p.dateCreation)}</div>
      </div>
      <button class="post-menu-btn" title="Options">⋮</button>
    </div>
    ${corpsTexte}
    ${media}
    <div class="post-stats">
      <span class="stat-likes stat-likes-lien">${p.nbLikes || 0} réaction(s)</span>
      <span>${p.nbCommentaires || 0} commentaire(s) · ${p.nbVues || 0} vues</span>
    </div>
    <div class="post-actions" style="position:relative;">
      <button class="post-action btn-reagir">👍 J'aime</button>
      <button class="post-action btn-commenter">💬 Commenter</button>
      <button class="post-action btn-partager">↗️ Partager</button>
    </div>
    <div class="commentaires-zone cache"></div>
  </article>`;
}

function htmlCarrouselPost(medias) {
  const id = 'carr-' + Math.random().toString(36).slice(2, 9);
  return `
  <div class="carrousel-post" id="${id}">
    <div class="carrousel-post-piste">
      ${medias.map(m => `<div class="carrousel-post-item"><img src="${m.url}"></div>`).join('')}
    </div>
    <span class="carrousel-position">1/${medias.length}</span>
  </div>`;
}

function brancherCarrousels(conteneur) {
  $$('.carrousel-post', conteneur).forEach(carr => {
    const piste = $('.carrousel-post-piste', carr);
    const badge = $('.carrousel-position', carr);
    const total = $$('.carrousel-post-item', carr).length;
    piste.addEventListener('scroll', () => {
      const position = Math.round(piste.scrollLeft / piste.clientWidth) + 1;
      badge.textContent = `${Math.min(position, total)}/${total}`;
    });
  });
}

/* ================= ÉCOSYSTÈME AUDIO ================= */
function creerEnregistreurAudio() {
  let mediaRecorder, morceaux = [], flux, debut;
  return {
    async demarrer() {
      flux = await navigator.mediaDevices.getUserMedia({ audio: true });
      morceaux = [];
      mediaRecorder = new MediaRecorder(flux);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size) morceaux.push(e.data); };
      mediaRecorder.start();
      debut = Date.now();
    },
    arreter() {
      return new Promise((resolve) => {
        mediaRecorder.onstop = () => {
          flux.getTracks().forEach(t => t.stop());
          resolve({ blob: new Blob(morceaux, { type: mediaRecorder.mimeType || 'audio/webm' }), dureeMs: Date.now() - debut });
        };
        mediaRecorder.stop();
      });
    },
    annuler() {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      flux?.getTracks().forEach(t => t.stop());
    }
  };
}

function formatDuree(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function htmlLecteurAudio(url, dureeMs) {
  return `<div class="bulle-audio">
    <audio src="${url}" preload="metadata"></audio>
    <button type="button" class="audio-play-btn">▶️</button>
    <div class="audio-onde"><div class="audio-onde-remplie"></div></div>
    <span class="audio-duree">${dureeMs ? formatDuree(dureeMs) : ''}</span>
  </div>`;
}

function brancherLecteursAudio(conteneur) {
  $$('.bulle-audio', conteneur).forEach(bulle => {
    if (bulle.dataset.branche) return;
    bulle.dataset.branche = '1';
    const audio = $('audio', bulle), btn = $('.audio-play-btn', bulle);
    const remplie = $('.audio-onde-remplie', bulle), dureeSpan = $('.audio-duree', bulle);
    btn.addEventListener('click', () => {
      if (audio.paused) {
        $$('audio').forEach(a => { if (a !== audio) a.pause(); });
        audio.play(); btn.textContent = '⏸️';
      } else { audio.pause(); btn.textContent = '▶️'; }
    });
    audio.addEventListener('timeupdate', () => { if (audio.duration) remplie.style.width = `${(audio.currentTime / audio.duration) * 100}%`; });
    audio.addEventListener('ended', () => { btn.textContent = '▶️'; remplie.style.width = '0%'; });
    audio.addEventListener('loadedmetadata', () => {
      if (!dureeSpan.textContent && isFinite(audio.duration)) dureeSpan.textContent = formatDuree(audio.duration * 1000);
    });
  });
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Convertit les URLs en liens cliquables et les mentions en tags colorés.
// On échappe d'abord le HTML (sécurité), puis on réintroduit uniquement
// les balises <a> et <span> qu'on contrôle.
function texteAvecLiens(s) {
  return escHtml(s)
    .replace(/https?:\/\/[^\s<>"]+/g, url => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="lien-post">${url}</a>`)
    .replace(/(^|\s)@([a-zà-üA-ZÀ-Ü0-9_]{1,25})/g, '$1<span class="mention-tag">@$2</span>');
}
function texteAvecMentions(s) { return texteAvecLiens(s); }

/* ================= MENTIONS @pseudo ================= */
function activerMentions(input, dropdown) {
  let requeteEnCours = 0;
  input.addEventListener('input', async () => {
    const curseur = input.selectionStart;
    const avant = input.value.slice(0, curseur);
    // Déclenché dès "@" suivi d'au moins 2 lettres consécutives (accents inclus).
    const m = avant.match(/(?:^|\s)@([a-zà-üA-ZÀ-Ü]{2,25})$/);
    if (!m) { dropdown.classList.add('cache'); return; }
    const idRequete = ++requeteEnCours;
    try {
      // Recherche sur le DÉBUT du nom complet du membre (insensible à la casse).
      const resultats = (await profils.rechercher(m[1])).slice(0, 6);
      if (idRequete !== requeteEnCours) return; // une saisie plus récente a eu lieu entre-temps
      if (!resultats.length) { dropdown.classList.add('cache'); return; }
      dropdown.innerHTML = resultats.map(p => `
        <div class="mention-item" data-jeton="${jetonMention(p)}">
          ${avatarHtml(p.avatarUrl, p.nomComplet, 'avatar avatar-sm')}
          <span><b>${p.nomComplet || 'Utilisateur'}</b>${p.pseudo ? ` @${p.pseudo}` : ''}</span>
        </div>`).join('');
      dropdown.classList.remove('cache');
      $$('.mention-item', dropdown).forEach(item => item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const avantMention = avant.replace(/@([a-zà-üA-ZÀ-Ü]{2,25})$/, `@${item.dataset.jeton} `);
        input.value = avantMention + input.value.slice(curseur);
        input.focus();
        dropdown.classList.add('cache');
      }));
    } catch { dropdown.classList.add('cache'); }
  });
  input.addEventListener('blur', () => setTimeout(() => dropdown.classList.add('cache'), 150));
}

// Le "jeton" inséré après @ ne doit jamais contenir d'espace (sinon la mention
// ne serait plus reconnue comme un seul mot) : on utilise le pseudo si la
// personne en a un, sinon son prénom.
function jetonMention(p) {
  return p.pseudo || (p.nomComplet || 'utilisateur').trim().split(/\s+/)[0];
}

activerMentions($('#composer-texte'), $('#composer-mentions'));

function htmlVideoImmersif(url) {
  return `
  <div class="video-immersif">
    <video src="${url}" playsinline></video>
    <div class="video-icone-etat cache">▶️</div>
    <div class="video-barre"><div class="video-barre-remplie"></div></div>
  </div>`;
}

function brancherVideosImmersives(conteneur, onDoubleTap) {
  let dernierScroll = 0;
  window.addEventListener('scroll', () => { dernierScroll = Date.now(); }, { passive: true });

  $$('.video-immersif', conteneur).forEach(zone => {
    const video = $('video', zone);
    const icone = $('.video-icone-etat', zone);
    const barreRemplie = $('.video-barre-remplie', zone);
    let minuteurAppuiLong = null;
    let futAppuiLong = false;
    let xDepart = 0, yDepart = 0;
    let dernierTap = 0;

    const afficherIcone = (emoji) => {
      icone.textContent = emoji;
      icone.classList.remove('cache');
      clearTimeout(icone._t);
      icone._t = setTimeout(() => icone.classList.add('cache'), 500);
    };

    video.addEventListener('timeupdate', () => {
      if (video.duration) barreRemplie.style.width = `${(video.currentTime / video.duration) * 100}%`;
    });

    zone.addEventListener('pointerdown', (e) => {
      futAppuiLong = false;
      xDepart = e.clientX; yDepart = e.clientY;
      const moitieDroite = (e.clientX - zone.getBoundingClientRect().left) > zone.clientWidth / 2;
      minuteurAppuiLong = setTimeout(() => {
        futAppuiLong = true;
        video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + (moitieDroite ? 1 : -1)));
        afficherIcone(moitieDroite ? '⏩' : '⏪');
      }, 350);
    });

    const annulerAppuiLong = () => clearTimeout(minuteurAppuiLong);
    zone.addEventListener('pointerup', (e) => {
      annulerAppuiLong();
      if (futAppuiLong) return; // c'était un appui long, pas un tap
      // Ni un vrai glissement (mouvement notable), ni un défilement tout juste terminé sur le conteneur.
      const deplacement = Math.max(Math.abs(e.clientX - xDepart), Math.abs(e.clientY - yDepart));
      if (deplacement > 10) return;
      if (Date.now() - dernierScroll < 200) return;

      const maintenant = Date.now();
      if (onDoubleTap && maintenant - dernierTap < 300) {
        dernierTap = 0;
        onDoubleTap(video, zone);
        return;
      }
      dernierTap = maintenant;

      if (video.paused) { video.play(); afficherIcone('▶️'); }
      else { video.pause(); afficherIcone('⏸️'); }
    });
    zone.addEventListener('pointerleave', annulerAppuiLong);
    zone.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}

function brancherPost(carte, p) {
  const id = p.id;
  const btnReagir = $('.btn-reagir', carte);

  $$('.post-auteur-lien', carte).forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    ouvrirProfil(el.dataset.auteur);
  }));
  $('.post-canal-lien', carte)?.addEventListener('click', (e) => {
    e.stopPropagation();
    ouvrirCanal(e.currentTarget.dataset.canal);
  });
  $('.stat-likes-lien', carte)?.addEventListener('click', () => ouvrirListeReactions(id));

  // affichage de l'état déjà réagi (déjà connu si posts.fil() l'a fourni ; sinon on le demande)
  const appliquerReaction = (type) => {
    if (type) { btnReagir.textContent = `${EMOJIS[type]} ${type.charAt(0) + type.slice(1).toLowerCase()}`; btnReagir.classList.add('actif'); }
  };
  if (p.maReaction !== undefined) appliquerReaction(p.maReaction);
  else posts.maReaction(id, etat.moi.id).then(appliquerReaction);

  let menuOuvert = false;
  btnReagir.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menuOuvert) return;
    menuOuvert = true;
    const menu = document.createElement('div');
    menu.className = 'reaction-menu';
    menu.innerHTML = Object.entries(EMOJIS).map(([type, emo]) => `<button data-type="${type}">${emo}</button>`).join('');
    btnReagir.parentElement.appendChild(menu);
    const fermer = () => { menu.remove(); menuOuvert = false; document.removeEventListener('click', fermer); };
    setTimeout(() => document.addEventListener('click', fermer), 10);
    $$('button', menu).forEach(b => b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try {
        await posts.reagir(id, b.dataset.type);
        btnReagir.textContent = `${EMOJIS[b.dataset.type]} ${b.dataset.type.charAt(0) + b.dataset.type.slice(1).toLowerCase()}`;
        btnReagir.classList.add('actif');
        toast('Réaction envoyée');
      } catch (err) { toast(err.message); }
      fermer();
    }));
  });

  $('.btn-commenter', carte).addEventListener('click', () => basculerCommentaires(carte, id));
  $('.btn-partager', carte).addEventListener('click', () => ouvrirPartagePost(p));

  const btnMenu = $('.post-menu-btn', carte);
  if (btnMenu) {
    btnMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      ouvrirMenuOptionsPost(p, btnMenu.parentElement, carte);
    });
  }
}

// Menu ⋮ : Modifier/Supprimer pour ses propres posts, Enregistrer/Masquer/Signaler pour ceux des autres
function ouvrirMenuOptionsPost(p, ancrage, carte) {
  const estMoi = p.auteurId === etat.moi.id;
  const menu = document.createElement('div');
  menu.className = 'reaction-menu post-options-menu';
  if (estMoi) {
    menu.innerHTML = `<button data-action="modifier">✏️ Modifier</button><button data-action="supprimer">🗑️ Supprimer</button>`;
  } else {
    menu.innerHTML = `
      <button data-action="enregistrer">🔖 Enregistrer</button>
      <button data-action="masquer">🙈 Masquer</button>
      <button data-action="signaler">🚩 Signaler</button>`;
  }
  ancrage.appendChild(menu);
  const fermer = () => { menu.remove(); document.removeEventListener('click', fermer); };
  setTimeout(() => document.addEventListener('click', fermer), 10);

  if (estMoi) {
    $('[data-action="modifier"]', menu).addEventListener('click', (e) => {
      e.stopPropagation(); fermer(); ouvrirEditionPost(carte, p);
    });
    $('[data-action="supprimer"]', menu).addEventListener('click', async (e) => {
      e.stopPropagation(); fermer();
      if (!confirm('Supprimer définitivement cette publication ?')) return;
      try { await posts.supprimer(p.id); carte?.remove(); toast('Publication supprimée'); }
      catch (err) { toast(err.message); }
    });
  } else {
    $('[data-action="enregistrer"]', menu).addEventListener('click', async (e) => {
      e.stopPropagation(); fermer();
      try {
        await profils.enregistrer(p.id, etat.moi.id);
        toast('Publication enregistrée 🔖');
      } catch { toast('Impossible d\'enregistrer.'); }
    });
    $('[data-action="masquer"]', menu).addEventListener('click', (e) => {
      e.stopPropagation(); fermer();
      carte?.remove();
      toast('Cette publication ne sera plus affichée.');
    });
    $('[data-action="signaler"]', menu).addEventListener('click', async (e) => {
      e.stopPropagation(); fermer();
      try {
        await posts.signaler(p.id, etat.moi.id);
        toast('Signalement envoyé. Merci 🚩');
      } catch { toast('Signalement envoyé. Merci 🚩'); }
    });
  }
}

function ouvrirEditionPost(carte, p) {
  ouvrirModale(`
    <h3>Modifier la publication</h3>
    <form id="form-edition-post" style="display:flex;flex-direction:column;gap:10px;">
      <textarea id="edition-post-texte" rows="4" style="padding:10px;border-radius:8px;border:1.5px solid var(--bordure);">${escHtml(p.texte)}</textarea>
      <button class="bouton bouton-principal bouton-large" type="submit">Enregistrer</button>
    </form>`);
  $('#form-edition-post').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nouveauTexte = $('#edition-post-texte').value.trim();
    try {
      await posts.modifier(p.id, nouveauTexte);
      p.texte = nouveauTexte;
      const cible = $('.post-texte, .post-texte-couleur', carte);
      if (cible) cible.innerHTML = cible.classList.contains('post-texte-couleur') ? escHtml(nouveauTexte) : texteAvecMentions(nouveauTexte);
      fermerModale();
      toast('Publication modifiée');
    } catch (err) { toast(err.message); }
  });
}

async function ouvrirPartagePost(p) {
  const url = `${location.origin}/post/${p.id}`;
  ouvrirModale(`
    <h3>Partager la publication</h3>
    <button class="bouton bouton-secondaire bouton-large" id="btn-copier-lien" style="margin-bottom:14px;">🔗 Copier le lien</button>
    <p class="sous-titre" style="margin:0 0 8px;">Envoyer à</p>
    <div id="partage-conversations"><p class="vide">Chargement des conversations...</p></div>`);
  $('#btn-copier-lien').addEventListener('click', () => {
    navigator.clipboard?.writeText(url);
    toast('Lien copié dans le presse-papiers');
  });
  try {
    const convs = await messages.conversations();
    const z = $('#partage-conversations');
    z.innerHTML = convs.length ? convs.map(c => `
      <div class="conv-item" data-id="${c.id}" data-autre="${c.autre_id}">
        ${avatarHtml(c.autre_avatar, c.autre_nom, 'avatar avatar-sm')}
        <span class="conv-nom">${c.autre_nom}</span>
        <button class="bouton bouton-principal bouton-sm" style="margin-left:auto;" data-envoyer="${c.id}">Envoyer</button>
      </div>`).join('') : '<p class="vide">Aucune conversation. Ouvre un profil pour en démarrer une.</p>';
    $$('[data-envoyer]', z).forEach(btn => btn.addEventListener('click', async () => {
      try {
        const texteApercu = (p.texte || '').slice(0, 80);
        await messages.envoyer({
          conversationId: btn.dataset.envoyer, expediteurId: etat.moi.id,
          texte: `📎 A partagé une publication de ${p.auteurNom}${texteApercu ? ` : "${texteApercu}"` : ''}\n${url}`
        });
        fermerModale();
        toast('Publication envoyée !');
      } catch (err) { toast(err.message); }
    }));
  } catch (err) { $('#partage-conversations').innerHTML = `<p class="vide">${err.message}</p>`; }
}

async function basculerCommentaires(carte, postId) {
  const zone = $('.commentaires-zone', carte);
  if (!zone.classList.contains('cache')) { zone.classList.add('cache'); return; }
  zone.classList.remove('cache');
  zone.innerHTML = '<p class="vide">Chargement...</p>';
  try {
    const liste = await commentaires.lister(postId);
    zone.innerHTML = `
      <div class="commentaires-items">
        ${liste.map(c => `
          <div class="commentaire" data-id="${c.id}">
            <div class="post-auteur-lien" data-auteur="${c.auteurId}">${avatarHtml(c.auteurAvatar, c.auteurNom, 'avatar avatar-sm')}</div>
            <div class="commentaire-corps">
              <div class="commentaire-auteur post-auteur-lien" data-auteur="${c.auteurId}">${c.auteurNom}</div>
              <div class="commentaire-texte">${c.typeMedia === 'AUDIO' && c.mediaUrl ? htmlLecteurAudio(c.mediaUrl, c.dureeAudioMs) : texteAvecMentions(c.texte)}</div>
              <div class="commentaire-footer">
                <span class="lien commentaire-repondre-btn">Répondre</span>
                ${c.nbReponses ? `<span class="lien commentaire-voir-reponses-btn">Voir les ${c.nbReponses} réponse${c.nbReponses > 1 ? 's' : ''}</span>` : ''}
              </div>
              <div class="reponses-zone cache"></div>
            </div>
            ${c.auteurId === etat.moi?.id ? `
              <div class="commentaire-actions">
                ${c.typeMedia !== 'AUDIO' ? `<button class="commentaire-action-btn btn-modif-commentaire" title="Modifier">✏️</button>` : ''}
                <button class="commentaire-action-btn btn-suppr-commentaire" title="Supprimer">🗑️</button>
              </div>` : ''}
          </div>`).join('') || '<p class="vide">Sois le premier à commenter.</p>'}
      </div>
      <form class="commentaire-form">
        <button type="button" class="bouton-micro" id="commentaire-audio-btn" title="Commentaire vocal">🎙️</button>
        <span class="audio-chrono cache" id="commentaire-audio-chrono">0:00</span>
        <input type="text" placeholder="Ajouter un commentaire... (@ pour mentionner)" required>
        <button class="bouton bouton-principal bouton-sm" type="submit">Envoyer</button>
      </form>
      <div class="mentions-dropdown cache"></div>`;
    brancherLecteursAudio(zone);
    $$('.post-auteur-lien', zone).forEach(el => el.addEventListener('click', (e) => {
      e.stopPropagation();
      ouvrirProfil(el.dataset.auteur);
    }));
    activerMentions($('.commentaire-form input', zone), $('.mentions-dropdown', zone));

    let enregistreurCommentaire = null;
    $('#commentaire-audio-btn', zone).addEventListener('click', async () => {
      const btnMic = $('#commentaire-audio-btn', zone);
      const chrono = $('#commentaire-audio-chrono', zone);
      if (!enregistreurCommentaire) {
        try {
          enregistreurCommentaire = creerEnregistreurAudio();
          await enregistreurCommentaire.demarrer();
          btnMic.classList.add('actif');
          chrono.classList.remove('cache');
          const debut = Date.now();
          btnMic._chronoId = setInterval(() => chrono.textContent = formatDuree(Date.now() - debut), 500);
        } catch { toast("Impossible d'accéder au micro."); enregistreurCommentaire = null; }
      } else {
        clearInterval(btnMic._chronoId);
        btnMic.classList.remove('actif'); chrono.classList.add('cache');
        const { blob, dureeMs } = await enregistreurCommentaire.arreter();
        enregistreurCommentaire = null;
        try {
          const url = await stockage.televerser(blob, 'commentaires');
          await commentaires.ajouter({
            postId, auteurId: etat.moi.id, auteurNom: etat.moi.nomComplet, auteurAvatar: etat.moi.avatarUrl,
            typeMedia: 'AUDIO', mediaUrl: url, dureeAudioMs: dureeMs
          });
          basculerCommentaires(carte, postId); basculerCommentaires(carte, postId);
        } catch (err) { toast(err.message); }
      }
    });

    $('.commentaire-form', zone).addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('input', e.target);
      const texte = input.value.trim();
      if (!texte) return;
      try {
        await commentaires.ajouter({ postId, auteurId: etat.moi.id, auteurNom: etat.moi.nomComplet, auteurAvatar: etat.moi.avatarUrl, texte });
        input.value = '';
        basculerCommentaires(carte, postId); basculerCommentaires(carte, postId);
      } catch (err) { toast(err.message); }
    });

    $$('.commentaire', zone).forEach(el => {
      const commentId = el.dataset.id;
      $('.btn-modif-commentaire', el)?.addEventListener('click', () => {
        const zoneTexte = $('.commentaire-texte', el);
        const texteActuel = liste.find(c => c.id === commentId)?.texte || '';
        zoneTexte.innerHTML = `<div class="commentaire-edition">
          <input type="text" value="${texteActuel.replace(/"/g, '&quot;')}">
          <button class="lien" data-ok="1">✓</button> <button class="lien" data-ok="0">✕</button>
        </div>`;
        const inputEdit = $('input', zoneTexte);
        inputEdit.focus();
        $('[data-ok="1"]', zoneTexte).addEventListener('click', async () => {
          const nouveau = inputEdit.value.trim();
          if (!nouveau) return;
          try {
            await commentaires.modifier(postId, commentId, nouveau);
            zoneTexte.innerHTML = texteAvecMentions(nouveau);
            toast('Commentaire modifié');
          } catch (err) { toast(err.message); }
        });
        $('[data-ok="0"]', zoneTexte).addEventListener('click', () => {
          zoneTexte.innerHTML = texteAvecMentions(texteActuel);
        });
      });
      $('.btn-suppr-commentaire', el)?.addEventListener('click', async () => {
        if (!confirm('Supprimer ce commentaire ?')) return;
        try {
          await commentaires.supprimer(postId, commentId);
          el.remove();
          const stat = $('.stat-likes + span', carte);
          if (stat) stat.textContent = stat.textContent.replace(/^\d+/, n => Math.max(0, parseInt(n) - 1));
          toast('Commentaire supprimé');
        } catch (err) { toast(err.message); }
      });

      const c = liste.find(x => x.id === commentId);
      const zoneReponses = $('.reponses-zone', el);

      $('.commentaire-repondre-btn', el).addEventListener('click', () => {
        if ($('.reponse-form', zoneReponses)) { $('input', zoneReponses).focus(); return; }
        zoneReponses.classList.remove('cache');
        zoneReponses.insertAdjacentHTML('beforeend', `
          <form class="commentaire-form reponse-form">
            <input type="text" placeholder="Répondre à ${c.auteurNom.split(' ')[0]}..." required>
            <button class="bouton bouton-principal bouton-sm" type="submit">Envoyer</button>
          </form>`);
        const inputRep = $('.reponse-form input', zoneReponses);
        inputRep.focus();
        $('.reponse-form', zoneReponses).addEventListener('submit', async (e) => {
          e.preventDefault();
          const texte = inputRep.value.trim();
          if (!texte) return;
          try {
            await commentaires.repondre({ postId, parentId: commentId, auteurId: etat.moi.id, auteurNom: etat.moi.nomComplet, auteurAvatar: etat.moi.avatarUrl, texte });
            basculerCommentaires(carte, postId); basculerCommentaires(carte, postId);
          } catch (err) { toast(err.message); }
        });
      });

      $('.commentaire-voir-reponses-btn', el)?.addEventListener('click', async (e) => {
        const btn = e.target;
        const conteneurReponses = zoneReponses.querySelector('.reponses-items');
        if (conteneurReponses) { conteneurReponses.classList.toggle('cache'); return; }
        zoneReponses.classList.remove('cache');
        btn.textContent = 'Chargement...';
        try {
          const reponses = await commentaires.listerReponses(postId, commentId);
          const div = document.createElement('div');
          div.className = 'reponses-items';
          div.innerHTML = reponses.map(r => `
            <div class="commentaire commentaire-reponse" data-id="${r.id}">
              <div class="post-auteur-lien" data-auteur="${r.auteurId}">${avatarHtml(r.auteurAvatar, r.auteurNom, 'avatar avatar-sm')}</div>
              <div class="commentaire-corps">
                <div class="commentaire-auteur post-auteur-lien" data-auteur="${r.auteurId}">${r.auteurNom}</div>
                <div class="commentaire-texte">${texteAvecMentions(r.texte)}</div>
              </div>
            </div>`).join('');
          zoneReponses.insertBefore(div, zoneReponses.firstChild);
          $$('.post-auteur-lien', div).forEach(a => a.addEventListener('click', (ev) => {
            ev.stopPropagation(); ouvrirProfil(a.dataset.auteur);
          }));
          btn.remove();
        } catch (err) { toast(err.message); }
      });
    });
  } catch (err) { zone.innerHTML = `<p class="vide">${err.message}</p>`; }
}

/* ================= GROUPES / PAGES / CANAUX ================= */
$$('[data-creer-canal]').forEach(btn => btn.addEventListener('click', () => {
  const type = btn.dataset.creerCanal;
  ouvrirModale(`
    <h3>${type === 'GROUPE' ? 'Créer un groupe' : 'Créer une page'}</h3>
    <form id="form-creer-canal" style="display:flex;flex-direction:column;gap:10px;">
      <input type="text" id="canal-nom" placeholder="Nom" required style="padding:10px;border-radius:8px;border:1.5px solid var(--bordure);">
      <textarea id="canal-desc" placeholder="Description" rows="3" style="padding:10px;border-radius:8px;border:1.5px solid var(--bordure);"></textarea>
      <button class="bouton bouton-principal bouton-large" type="submit">Créer</button>
    </form>`);
  $('#form-creer-canal').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const c = await canaux.creer({
        nom: $('#canal-nom').value.trim(), type,
        description: $('#canal-desc').value.trim(), proprietaireId: etat.moi.id
      });
      fermerModale(); toast('Créé !');
      ouvrirCanal(c.id);
    } catch (err) { toast(err.message); }
  });
}));

async function chargerCanaux(type) {
  const prefix = type === 'GROUPE' ? 'groupes' : 'pages';
  const zMes = $(`#${prefix}-mes`), zSug = $(`#${prefix}-suggeres`);
  zMes.innerHTML = zSug.innerHTML = '<p class="vide">Chargement...</p>';
  // On invalide le cache à chaque ouverture de l'onglet pour toujours afficher
  // l'état réel (évite le bug "Tu n'as encore rejoint aucun canal" après un join)
  invaliderCacheListe(`canaux:${etat.moi.id}`);
  try {
    const [mes, suggeres] = await Promise.all([canaux.mesCanaux(etat.moi.id, type), canaux.suggeres(type)]);
    zMes.innerHTML = mes.length ? mes.map(carteCanal).join('') : '<p class="vide">Tu n\'as encore rejoint aucun canal.</p>';
    zSug.innerHTML = suggeres.length ? suggeres.map(carteCanal).join('') : '<p class="vide">Aucune suggestion pour l\'instant.</p>';
    [zMes, zSug].forEach(z => $$('.canal-carte', z).forEach(el => el.addEventListener('click', () => ouvrirCanal(el.dataset.id))));
  } catch (err) { zMes.innerHTML = `<p class="vide">${err.message}</p>`; }
}

function carteCanal(c) {
  const estPage = c.type === 'PAGE';
  const visuel = estPage
    ? (c.imageUrl ? `<img src="${c.imageUrl}" class="canal-logo-rond">` : `<div class="canal-logo-rond" style="background:var(--vert-clair);"></div>`)
    : (c.couvertureUrl ? `<img src="${c.couvertureUrl}">` : `<div style="width:48px;height:48px;border-radius:12px;background:var(--vert-clair);"></div>`);
  return `<div class="canal-carte" data-id="${c.id}">
    ${visuel}
    <div class="canal-infos">
      <div class="canal-nom">${c.nom}</div>
      <div class="canal-membres">${c.nbMembres || 0} membre(s) · ${estPage ? 'Page' : 'Groupe'}</div>
    </div>
  </div>`;
}

function ouvrirParametresCanal(c) {
  const estPage = c.type === 'PAGE';
  ouvrirModale(`
    <h3>Paramètres : ${c.nom}</h3>
    <form id="form-canal-params" style="display:flex;flex-direction:column;gap:10px;">
      <input type="text" id="canal-param-nom" class="edit-input" value="${c.nom || ''}" placeholder="Nom">
      <textarea id="canal-param-desc" class="edit-input" rows="2" placeholder="Description">${c.description || ''}</textarea>
      ${estPage ? `
        <input type="text" id="canal-param-tel" class="edit-input" value="${c.telephone || ''}" placeholder="Téléphone">
        <input type="text" id="canal-param-email" class="edit-input" value="${c.email || ''}" placeholder="Email">
        <input type="text" id="canal-param-site" class="edit-input" value="${c.siteweb || ''}" placeholder="Site web">
        <input type="text" id="canal-param-lieu" class="edit-input" value="${c.localisation || ''}" placeholder="Localisation">
      ` : ''}
      <label style="font-size:.82rem;color:var(--texte-att);">Photo/Logo
        <input type="file" id="canal-param-image" accept="image/*" style="display:block;margin-top:4px;">
      </label>
      <label style="font-size:.82rem;color:var(--texte-att);">Photo de couverture
        <input type="file" id="canal-param-couv" accept="image/*" style="display:block;margin-top:4px;">
      </label>
      <div class="edit-boutons">
        <button type="button" class="edit-btn-annuler" id="canal-param-supprimer" style="color:var(--erreur);">🗑️ Supprimer</button>
        <button type="submit" class="edit-btn-enregistrer">Enregistrer</button>
      </div>
    </form>`);

  $('#form-canal-params').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('.edit-btn-enregistrer');
    btn.disabled = true; btn.textContent = '...';
    try {
      let imageUrl = c.imageUrl;
      let couvertureUrl = c.couvertureUrl;
      const fichierImage = $('#canal-param-image').files[0];
      const fichierCouv = $('#canal-param-couv').files[0];
      if (fichierImage) imageUrl = await stockage.televerser(fichierImage, 'canaux');
      if (fichierCouv) couvertureUrl = await stockage.televerser(fichierCouv, 'canaux-couvertures');
      await canaux.modifier(c.id, {
        nom: $('#canal-param-nom').value.trim(),
        description: $('#canal-param-desc').value.trim(),
        imageUrl, couvertureUrl,
        ...(estPage ? {
          telephone: $('#canal-param-tel').value.trim(),
          email: $('#canal-param-email').value.trim(),
          siteweb: $('#canal-param-site').value.trim(),
          localisation: $('#canal-param-lieu').value.trim()
        } : {})
      });
      fermerModale();
      toast('Paramètres enregistrés !');
      chargerContenuCanal(c.id);
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Enregistrer'; }
  });

  $('#canal-param-supprimer').addEventListener('click', async () => {
    if (!confirm(`Supprimer définitivement "${c.nom}" ? Cette action est irréversible.`)) return;
    try {
      await canaux.supprimer(c.id);
      fermerModale();
      toast('Canal supprimé.');
      allerA(c.type === 'PAGE' ? 'pages' : 'groupes');
    } catch (err) { toast(err.message); }
  });
}

function ouvrirCanal(id) {
  allerA('canal', false, id);
  chargerContenuCanal(id);
}

async function chargerContenuCanal(id) {
  const entete = $('#canal-entete'), fil = $('#canal-fil'), accueil = $('#canal-accueil');
  const headerVisuel = $('#canal-header-visuel');
  entete.innerHTML = '<p class="vide">Chargement...</p>';
  fil.innerHTML = ''; accueil.innerHTML = '';
  try {
    const c = await canaux.obtenir(id);
    etat.canalCourant = c;
    const membre = await canaux.estMembre(id, etat.moi.id);
    const estPage = c.type === 'PAGE';
    const estProprietaire = c.proprietaireId === etat.moi.id;

    // Couverture pleine largeur + logo superposé
    headerVisuel.style.backgroundImage = c.couvertureUrl ? `url('${c.couvertureUrl}')` : '';
    headerVisuel.classList.toggle('avec-couverture', !!c.couvertureUrl);

    // Bouton paramètres
    const btnParams = $('#canal-btn-params');
    btnParams.classList.toggle('cache', !estProprietaire);
    btnParams.onclick = () => ouvrirParametresCanal(c);

    // Entête : logo + nom + description + boutons
    const logoHtml = c.imageUrl
      ? `<img src="${c.imageUrl}" class="canal-logo-rond" style="width:72px;height:72px;">`
      : `<div class="canal-logo-rond" style="width:72px;height:72px;background:var(--vert-clair);display:flex;align-items:center;justify-content:center;font-size:1.8rem;">👥</div>`;

    const infosPage = estPage && (c.telephone || c.email || c.siteweb) ? `
      <div class="canal-infos-page">
        ${c.telephone ? `<span>📞 ${c.telephone}</span>` : ''}
        ${c.email ? `<span>✉️ ${c.email}</span>` : ''}
        ${c.siteweb ? `<a href="${c.siteweb}" target="_blank" rel="noopener" class="lien-post">🌐 Visiter</a>` : ''}
      </div>` : '';

    entete.innerHTML = `
      <div class="canal-logo-zone">${logoHtml}</div>
      <h2 class="canal-nom-titre">${c.nom}</h2>
      <p class="canal-membres">${c.nbMembres || 0} membre(s) · ${estPage ? 'Page' : 'Groupe'}${c.localisation ? ` · 📍 ${c.localisation}` : ''}</p>
      ${c.description ? `<p class="canal-desc-txt">${c.description}</p>` : ''}
      ${infosPage}
      <div class="canal-boutons-action">
        ${!estProprietaire ? `<button id="btn-adhesion" class="bouton ${membre ? 'bouton-secondaire' : 'bouton-principal'} bouton-large">${membre ? '✓ Membre' : '+ Rejoindre'}</button>` : ''}
        ${estPage && !estProprietaire ? `<button class="bouton bouton-secondaire" id="btn-canal-message">✉️ Message</button>` : ''}
      </div>`;

    $('#btn-adhesion')?.addEventListener('click', async (e) => {
      try {
        if (membre) await canaux.quitter(id, etat.moi.id); else await canaux.rejoindre(id, etat.moi.id);
        toast(membre ? 'Tu as quitté le groupe' : 'Tu as rejoint le groupe !');
        chargerContenuCanal(id);
      } catch (err) { toast(err.message); }
    });
    $('#btn-canal-message')?.addEventListener('click', () => demarrerConversationAvec(c.proprietaireId, c.nom, c.imageUrl));

    // Composer (membres + propriétaire)
    const canalComposer = $('#canal-composer');
    canalComposer.classList.toggle('cache', !membre && !estProprietaire);

    const btnPublierCanal = $('#canal-publier');
    const champFichierCanal = $('#canal-fichier');
    const apercuCanal = $('#canal-apercu');
    let fichierCanalChoisi = null;

    champFichierCanal.addEventListener('change', (e) => {
      fichierCanalChoisi = e.target.files[0];
      if (!fichierCanalChoisi) return;
      const url = URL.createObjectURL(fichierCanalChoisi);
      apercuCanal.innerHTML = fichierCanalChoisi.type.startsWith('video') ? `<video src="${url}" muted controls></video>` : `<img src="${url}">`;
      apercuCanal.classList.remove('cache');
    });

    btnPublierCanal.onclick = async () => {
      const texte = $('#canal-texte').value.trim();
      if (!texte && !fichierCanalChoisi) return toast('Écris quelque chose ou ajoute une photo/vidéo.');
      btnPublierCanal.disabled = true; btnPublierCanal.textContent = '...';
      try {
        let mediaUrl = null, typeMedia = 'TEXTE';
        if (fichierCanalChoisi) {
          typeMedia = fichierCanalChoisi.type.startsWith('video') ? 'VIDEO' : 'IMAGE';
          const { onProgression, retirer } = creerBarreProgression(canalComposer);
          mediaUrl = await stockage.televerser(fichierCanalChoisi, 'posts', onProgression);
          retirer();
        }
        await posts.publier({
          auteurId: etat.moi.id, auteurNom: etat.moi.nomComplet, auteurAvatar: etat.moi.avatarUrl,
          texte, typeMedia, mediaUrl, medias: null, dureeAudioMs: null, couleurFond: null,
          channelId: id, channelNom: c.nom
        });
        $('#canal-texte').value = '';
        fichierCanalChoisi = null; champFichierCanal.value = '';
        apercuCanal.classList.add('cache'); apercuCanal.innerHTML = '';
        toast('Publié dans ' + c.nom + ' !');
        if (!fil.classList.contains('cache')) { fil.innerHTML = ''; renderFil(fil, await posts.parCanal(id)); }
      } catch (err) { toast(err.message); }
      finally { btnPublierCanal.disabled = false; btnPublierCanal.textContent = 'Publier'; }
    };

    // Onglets Membres / Publications / Médias
    $$('#ecran-canal .profil-onglet-btn').forEach(b => b.classList.toggle('actif', b.dataset.souscanal === 'accueil'));
    const zMed = $('#canal-medias');
    accueil.classList.remove('cache'); fil.classList.add('cache'); zMed.classList.add('cache');
    accueil.innerHTML = '<p class="vide">Chargement des membres...</p>';
    canaux.listerMembres(id).then(membres => {
      accueil.innerHTML = membres.length ? `
        <div class="suggestions-liste" style="margin-top:12px;">
          ${membres.map(p => `<div class="suggestion-carte" data-uid="${p.id}">${avatarHtml(p.avatarUrl, p.nomComplet, 'avatar')}<span class="suggestion-nom">${p.nomComplet || 'Utilisateur'}</span></div>`).join('')}
        </div>` : '<p class="vide">Aucun membre pour le moment.</p>';
      $$('.suggestion-carte', accueil).forEach(el => el.addEventListener('click', () => ouvrirProfil(el.dataset.uid)));
    }).catch(() => { accueil.innerHTML = '<p class="vide">Impossible de charger les membres.</p>'; });

  } catch (err) { entete.innerHTML = `<p class="vide">${err.message}</p>`; }
}

// Délégation globale des onglets canal
$('#ecran-canal').addEventListener('click', async (e) => {
  const btn = e.target.closest('.profil-onglet-btn[data-souscanal]');
  if (!btn || !etat.canalCourant) return;
  const id = etat.canalCourant.id;
  $$('#ecran-canal .profil-onglet-btn').forEach(b => b.classList.toggle('actif', b === btn));
  const onglet = btn.dataset.souscanal;
  const accueil = $('#canal-accueil'), fil = $('#canal-fil'), zMed = $('#canal-medias');
  accueil.classList.toggle('cache', onglet !== 'accueil');
  fil.classList.toggle('cache', onglet !== 'publications');
  zMed.classList.toggle('cache', onglet !== 'medias');
  if (onglet === 'publications' && !fil.children.length) {
    fil.innerHTML = '<p class="vide">Chargement...</p>';
    try { renderFil(fil, await posts.parCanal(id)); }
    catch (err) { fil.innerHTML = `<p class="vide">${err.message}</p>`; }
  }
  if (onglet === 'medias' && !zMed.dataset.charge) {
    zMed.dataset.charge = '1';
    zMed.innerHTML = '<p class="vide">Chargement...</p>';
    try {
      const medias = (await posts.parCanal(id)).filter(p => p.mediaUrl && (p.typeMedia === 'IMAGE' || p.typeMedia === 'VIDEO'));
      zMed.innerHTML = medias.length ? `<div class="medias-grille">${medias.map(m => `<div class="media-vignette">${m.typeMedia === 'VIDEO' ? `<video src="${m.mediaUrl}" muted></video><span class="media-badge-video">▶</span>` : `<img src="${m.mediaUrl}">`}</div>`).join('')}</div>` : '<p class="vide">Aucun média dans ce canal.</p>';
    } catch (err) { zMed.innerHTML = `<p class="vide">${err.message}</p>`; }
  }
});

/* ================= VIDÉO ================= */
async function chargerVideos() {
  const z = $('#video-liste');
  z.innerHTML = '<p class="vide">Chargement...</p>';
  try {
    const data = await posts.videos();
    if (!data.length) { z.innerHTML = '<p class="vide" style="color:#fff;">Aucune vidéo pour le moment.</p>'; return; }
    z.innerHTML = data.map(p => htmlReel(p)).join('');
    brancherReels(z, data);
  } catch (err) { z.innerHTML = `<p class="vide">${err.message}</p>`; }
}

function htmlReel(p) {
  const texteLong = (p.texte || '').length > 70;
  const prenom = (p.auteurNom || 'lui').split(' ')[0];
  return `
  <div class="reel-slide" data-id="${p.id}">
    <div class="video-immersif reel-video">
      <video src="${p.mediaUrl}" playsinline loop></video>
      <div class="video-icone-etat cache">▶️</div>
      <div class="coeur-double-tap cache">❤️</div>
      <button class="reel-son-btn" title="Son">🔊</button>
      <div class="video-barre"><div class="video-barre-remplie"></div></div>
    </div>

    <div class="reel-actions">
      <button class="reel-action-btn btn-options" title="Options">⋮</button>
      <div class="reel-action-reagir-zone">
        <div class="reel-avatar-zone post-auteur-lien" data-auteur="${p.auteurId}">
          ${avatarHtml(p.auteurAvatar, p.auteurNom, 'avatar avatar-sm')}
          <button class="reel-suivre-btn cache" data-auteur="${p.auteurId}">+</button>
        </div>
        <button class="reel-action-btn btn-reagir">❤️<span>${p.nbLikes || 0}</span></button>
      </div>
      <button class="reel-action-btn btn-commenter">💬<span>${p.nbCommentaires || 0}</span></button>
      <button class="reel-action-btn btn-partager">↗️</button>
    </div>

    <div class="reel-infos">
      <div class="reel-infos-nom">
        <b class="post-auteur-lien" data-auteur="${p.auteurId}">${p.auteurNom}</b>
        <span class="reel-temps">${tempsRelatif(p.dateCreation)}</span>
        ${p.auteurId !== etat.moi?.id ? `<button class="reel-suivre-inline cache" data-auteur="${p.auteurId}">+ Suivre</button>` : ''}
      </div>
      ${p.texte ? `<p class="reel-legende ${texteLong ? 'reel-legende-repliee' : ''}">${texteAvecMentions(p.texte)}${texteLong ? ` <span class="reel-legende-toggle">…plus</span>` : ''}</p>` : ''}
    </div>

    <form class="reel-reponse-rapide">
      <button type="button" class="reel-envoyer-btn">➤</button>
      <input type="text" placeholder="Écrire à ${prenom}...">
      <div class="reel-emojis-rapides">
        <button type="button" data-emoji="😍">😍</button>
        <button type="button" data-emoji="😂">😂</button>
        <button type="button" data-emoji="😮">😮</button>
      </div>
    </form>

    <div class="commentaires-zone reel-commentaires cache"></div>
  </div>`;
}

function brancherReels(conteneur, data) {
  brancherVideosImmersives(conteneur, async (video, zone) => {
    const slide = zone.closest('.reel-slide');
    if (!slide) return;
    const p = data.find(d => d.id === slide.dataset.id);
    if (!p) return;
    try {
      await posts.reagir(p.id, 'JAIME');
      const btn = $('.btn-reagir', slide);
      if (!btn.classList.contains('actif')) {
        btn.innerHTML = `${EMOJIS.JAIME}<span>${Number($('span', btn)?.textContent || p.nbLikes || 0) + 1}</span>`;
        btn.classList.add('actif');
      }
    } catch (err) { toast(err.message); }
    const coeur = $('.coeur-double-tap', slide);
    coeur.classList.remove('cache');
    void coeur.offsetWidth; // relance l'animation si déjà jouée
    coeur.classList.add('anime');
    setTimeout(() => { coeur.classList.add('cache'); coeur.classList.remove('anime'); }, 800);
  });
  const slides = $$('.reel-slide', conteneur);
  let slideActive = null;

  const observateur = new IntersectionObserver((entrees) => {
    entrees.forEach(entree => {
      const video = $('video', entree.target);
      if (!video) return;
      if (entree.isIntersecting && entree.intersectionRatio > 0.75) {
        // Cette vidéo devient la nouvelle vidéo active : on coupe l'ancienne sans attendre.
        if (slideActive && slideActive !== entree.target) {
          const ancienneVideo = $('video', slideActive);
          if (ancienneVideo) ancienneVideo.pause();
        }
        slideActive = entree.target;
        video.play().catch(() => {});
      } else if (entree.target === slideActive && entree.intersectionRatio < 0.4) {
        video.pause();
        slideActive = null;
      } else if (!entree.isIntersecting && entree.target !== slideActive) {
        video.pause(); // sécurité supplémentaire pour toute vidéo hors champ
      }
    });
  }, { root: null, threshold: [0, 0.4, 0.75] });

  slides.forEach(slide => {
    const p = data.find(d => d.id === slide.dataset.id);
    const video = $('video', slide);

    $$('.post-auteur-lien', slide).forEach(el => el.addEventListener('click', (e) => {
      e.stopPropagation();
      ouvrirProfil(p.auteurId);
    }));

    // Son activé par défaut — l'utilisateur peut couper le son via le bouton 🔊
    video.muted = false;
    const btnSon = $('.reel-son-btn', slide);
    btnSon.textContent = '🔊';
    btnSon.addEventListener('click', (e) => {
      e.stopPropagation();
      video.muted = !video.muted;
      btnSon.textContent = video.muted ? '🔇' : '🔊';
    });

    // Bouton "Suivre" superposé sur l'avatar (masqué pour ses propres publications ou si déjà abonné)
    const btnSuivre = $('.reel-suivre-btn', slide);
    const btnSuivreInline = $('.reel-suivre-inline', slide);
    if (p.auteurId !== etat.moi.id) {
      profils.estAbonne(etat.moi.id, p.auteurId).then(dejaAbonne => {
        if (!dejaAbonne) {
          btnSuivre?.classList.remove('cache');
          btnSuivreInline?.classList.remove('cache');
        }
      }).catch(() => {});
      const suivre = async (e) => {
        e.stopPropagation();
        try {
          await profils.suivre(etat.moi.id, p.auteurId);
          btnSuivre?.classList.add('cache');
          btnSuivreInline?.classList.add('cache');
          toast(`Tu suis maintenant ${p.auteurNom.split(' ')[0]}`);
        } catch (err) { toast(err.message); }
      };
      btnSuivre?.addEventListener('click', suivre);
      btnSuivreInline?.addEventListener('click', suivre);
    }

    // Légende repliable si trop longue
    $('.reel-legende-toggle', slide)?.addEventListener('click', (e) => {
      e.stopPropagation();
      const legende = e.target.closest('.reel-legende');
      const repliee = legende.classList.toggle('reel-legende-repliee');
      e.target.textContent = repliee ? '…plus' : 'moins';
    });

    posts.maReaction(p.id, etat.moi.id).then(type => {
      if (type) { $('.btn-reagir', slide).innerHTML = `${EMOJIS[type]}<span>${p.nbLikes || 0}</span>`; $('.btn-reagir', slide).classList.add('actif'); }
    });

    async function reagirEtAnimer(type) {
      try {
        await posts.reagir(p.id, type);
        const btn = $('.btn-reagir', slide);
        btn.innerHTML = `${EMOJIS[type]}<span>${Number($('span', btn)?.textContent || p.nbLikes || 0) + (btn.classList.contains('actif') ? 0 : 1)}</span>`;
        btn.classList.add('actif');
      } catch (err) { toast(err.message); }
    }

    let menuReactionOuvert = false;
    $('.btn-reagir', slide).addEventListener('click', (e) => {
      e.stopPropagation();
      if (menuReactionOuvert) return;
      menuReactionOuvert = true;
      const btn = $('.btn-reagir', slide);
      const menu = document.createElement('div');
      menu.className = 'reaction-menu reel-reaction-menu';
      menu.innerHTML = Object.entries(EMOJIS).map(([type, emo]) => `<button data-type="${type}">${emo}</button>`).join('');
      $('.reel-action-reagir-zone', slide).appendChild(menu);
      const fermer = () => { menu.remove(); menuReactionOuvert = false; document.removeEventListener('click', fermer); };
      setTimeout(() => document.addEventListener('click', fermer), 10);
      $$('button', menu).forEach(b => b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await reagirEtAnimer(b.dataset.type);
        toast('Réaction envoyée');
        fermer();
      }));
    });
    $('.btn-commenter', slide).addEventListener('click', (e) => { e.stopPropagation(); basculerCommentaires(slide, p.id); });
    $('.btn-partager', slide).addEventListener('click', (e) => { e.stopPropagation(); ouvrirPartagePost(p); });

    // Menu options (⋮)
    $('.btn-options', slide).addEventListener('click', (e) => {
      e.stopPropagation();
      ouvrirMenuOptionsPost(p, slide, slide);
    });

    // Barre de réponse rapide (texte libre ou emoji en un tap) — envoyée comme
    // message avec un aperçu du reel joint, façon Instagram, plutôt qu'en commentaire public.
    async function envoyerReponseRapide(texte) {
      if (!texte || p.auteurId === etat.moi.id) return;
      try {
        const convId = await messages.ouvrirAvec(p.auteurId);
        await messages.envoyer({
          conversationId: convId, expediteurId: etat.moi.id, texte,
          storyId: p.id, storyApercu: p.mediaUrl, storyTypeMedia: p.typeMedia
        });
        toast('Envoyé en message !');
      } catch (err) { toast(err.message); }
    }
    const formReponse = $('.reel-reponse-rapide', slide);
    formReponse.addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const input = $('input', formReponse);
      const texte = input.value.trim();
      input.value = '';
      envoyerReponseRapide(texte);
    });
    $('.reel-envoyer-btn', formReponse).addEventListener('click', (e) => {
      e.stopPropagation();
      formReponse.requestSubmit();
    });
    $$('.reel-emojis-rapides button', formReponse).forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      envoyerReponseRapide(b.dataset.emoji);
    }));

    observateur.observe(slide);
  });
}

/* ================= DJASSA (MARKETPLACE) ================= */
let fichiersDjassaChoisis = [];

function rafraichirApercuDjassa() {
  const zone = $('#djassa-apercu');
  if (!fichiersDjassaChoisis.length) { zone.classList.add('cache'); zone.innerHTML = ''; return; }
  zone.classList.remove('cache');
  zone.innerHTML = `<div class="carrousel-apercu">
    ${fichiersDjassaChoisis.map((f, i) => `
      <div class="carrousel-apercu-item">
        <img src="${URL.createObjectURL(f)}">
        <button type="button" class="apercu-retirer" data-i="${i}">✕</button>
      </div>`).join('')}
    <button type="button" class="carrousel-ajouter" id="djassa-ajouter-photo">+ Ajouter</button>
  </div>`;
  $$('.apercu-retirer', zone).forEach(b => b.addEventListener('click', () => {
    fichiersDjassaChoisis.splice(Number(b.dataset.i), 1);
    rafraichirApercuDjassa();
  }));
  $('#djassa-ajouter-photo')?.addEventListener('click', () => $('#djassa-image').click());
}

$('#djassa-publier-btn').addEventListener('click', () => $('#djassa-form').classList.toggle('cache'));

$('#djassa-image').addEventListener('change', (e) => {
  const nouveaux = [...e.target.files];
  if (!nouveaux.length) return;
  fichiersDjassaChoisis = [...fichiersDjassaChoisis, ...nouveaux].slice(0, 8);
  e.target.value = '';
  rafraichirApercuDjassa();
});

$('#djassa-publier-confirmer').addEventListener('click', async () => {
  const titre = $('#djassa-titre').value.trim();
  if (!titre) return toast('Indique un titre.');
  const btn = $('#djassa-publier-confirmer');
  btn.disabled = true;
  const texteInitial = btn.textContent;
  try {
    const imagesUrls = [];
    for (let i = 0; i < fichiersDjassaChoisis.length; i++) {
      btn.textContent = `Envoi ${i + 1}/${fichiersDjassaChoisis.length}...`;
      imagesUrls.push(await stockage.televerser(fichiersDjassaChoisis[i], 'djassa'));
    }
    await djassa.publier({
      vendeurId: etat.moi.id, titre,
      description: $('#djassa-description').value.trim(),
      prix: parseFloat($('#djassa-prix').value) || 0,
      categorie: $('#djassa-categorie').value.trim(),
      imageUrl: imagesUrls[0] || '',
      imagesUrls,
      telephone: $('#djassa-tel').value.trim()
    });
    ['#djassa-titre', '#djassa-description', '#djassa-prix', '#djassa-categorie', '#djassa-tel']
      .forEach(s => $(s).value = '');
    $('#djassa-image').value = '';
    fichiersDjassaChoisis = [];
    $('#djassa-apercu').classList.add('cache'); $('#djassa-apercu').innerHTML = '';
    $('#djassa-form').classList.add('cache');
    toast('Annonce publiée !');
    chargerDjassa();
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = texteInitial; }
});

async function chargerDjassa() {
  const z = $('#djassa-liste');
  z.innerHTML = '<p class="vide">Chargement...</p>';
  try {
    const data = await djassa.lister();
    z.innerHTML = data.length ? data.map(a => `
      <div class="djassa-carte" data-id="${a.id}">
        ${a.image_url ? `<img src="${a.image_url}">` : `<div style="height:110px;background:var(--corail-clair);"></div>`}
        <div class="djassa-corps">
          <p class="djassa-titre">${escHtml(a.titre)}</p>
          <p class="djassa-prix">${Number(a.prix).toLocaleString('fr-FR')} ${a.devise}</p>
          <p style="font-size:.72rem;color:var(--texte-att);">${a.vendeur_nom}</p>
        </div>
      </div>`).join('') : '<p class="vide">Aucune annonce pour le moment.</p>';
    $$('.djassa-carte', z).forEach(el => el.addEventListener('click', () => ouvrirDetailDjassa(el.dataset.id)));
  } catch (err) { z.innerHTML = `<p class="vide">${err.message}</p>`; }
}

async function ouvrirDetailDjassa(id) {
  ouvrirModale('<p class="vide">Chargement...</p>');
  try {
    const a = await djassa.obtenir(id);
    if (!a) return ouvrirModale('<p class="vide">Cette annonce a été retirée.</p>');
    const images = a.images_urls.length ? a.images_urls : (a.image_url ? [a.image_url] : []);
    const carrousel = images.length
      ? `<div class="carrousel-post" id="carr-djassa">
          <div class="carrousel-post-piste">${images.map(u => `<div class="carrousel-post-item"><img src="${u}"></div>`).join('')}</div>
          ${images.length > 1 ? `<span class="carrousel-position">1/${images.length}</span>` : ''}
        </div>`
      : `<div style="height:180px;background:var(--corail-clair);border-radius:var(--rayon-sm);margin-bottom:10px;"></div>`;
    ouvrirModale(`
      ${carrousel}
      <h3 style="margin:0 0 4px;">${escHtml(a.titre)}</h3>
      <p class="djassa-prix" style="font-size:1.1rem;">${Number(a.prix).toLocaleString('fr-FR')} ${a.devise}</p>
      <p style="color:var(--texte-att);font-size:.88rem;margin:6px 0 4px;">Vendu par ${a.vendeur_nom}</p>
      <p style="font-size:.9rem;line-height:1.4;white-space:pre-wrap;">${escHtml(a.description || '')}</p>
      <div class="canal-actions-page" style="margin-top:14px;">
        ${a.telephone ? `<a class="bouton bouton-secondaire bouton-sm" href="tel:${a.telephone}">📞 Appeler le vendeur</a>` : ''}
        ${a.vendeurId !== etat.moi.id ? `<button class="bouton bouton-secondaire bouton-sm" id="btn-djassa-message">✉️ Message</button>` : ''}
      </div>`);
    brancherCarrousels($('#modale-contenu'));
    $('#btn-djassa-message')?.addEventListener('click', () => {
      fermerModale();
      demarrerConversationAvec(a.vendeurId, a.vendeur_nom, null);
    });
  } catch (err) { ouvrirModale(`<p class="vide">${err.message}</p>`); }
}

/* ================= NOTIFICATIONS ================= */
const LIBELLES_NOTIF = {
  LIKE: 'a réagi à ta publication', REACTION: 'a réagi à ta publication', COMMENTAIRE: 'a commenté ta publication',
  REPONSE: 'a répondu à ton commentaire', ABONNE: "s'est abonné(e) à toi", MESSAGE: "t'a envoyé un message"
};

function rendreNotifications(liste) {
  const z = $('#notifications-liste');
  z.innerHTML = liste.length ? liste.map(n => `
    <div class="notif-item ${n.lu ? '' : 'non-lue'}" data-id="${n.id}">
      ${avatarHtml(n.acteurAvatar, n.acteurNom, 'avatar avatar-sm')}
      <div>
        <div class="notif-texte"><b>${n.acteurNom}</b> ${LIBELLES_NOTIF[n.type] || n.texte}</div>
        <div class="notif-date">${tempsRelatif(n.date)}</div>
      </div>
    </div>`).join('') : '<p class="vide">Aucune notification pour l\'instant.</p>';
  $$('.notif-item', z).forEach(el => el.addEventListener('click', () => {
    const n = liste.find(x => x.id === el.dataset.id);
    if (n) ouvrirActionNotification(n);
  }));
}

// Ouvre l'endroit où s'est produite l'action à l'origine de la notification :
// le post pour une réaction/un commentaire, le profil pour un nouvel abonné,
// la conversation pour un message.
async function ouvrirActionNotification(n) {
  if (n.type === 'REACTION' || n.type === 'LIKE' || n.type === 'COMMENTAIRE' || n.type === 'REPONSE') {
    await ouvrirPost(n.cibleId, { deplierCommentaires: n.type === 'COMMENTAIRE' || n.type === 'REPONSE' });
  } else if (n.type === 'ABONNE') {
    ouvrirProfil(n.acteurId);
  } else if (n.type === 'MESSAGE') {
    allerA('messages');
    ouvrirChat(n.cibleId, n.acteurNom, n.acteurAvatar);
  }
}

// Ouvre un post dans une fenêtre modale avec sa propre URL (/post/{id}),
// utilisable aussi bien pour un lien partagé qu'une notification ou une
// recherche — chaque post a ainsi une adresse consultable/partageable.
async function ouvrirPost(postId, { deplierCommentaires, avecTelechargement } = {}) {
  try {
    const p = await posts.obtenir(postId);
    if (!p) return toast("Cette publication n'existe plus.");
    const pied = avecTelechargement ? `
      <p style="text-align:center;margin-top:14px;">
        <a class="lien" href="https://github.com/armeles7/kozons-releases/releases/latest/download/Kozons.apk">📥 Télécharger l'app KoZons</a>
      </p>` : '';
    ouvrirModale(`<div class="fil-liste">${cartePost(p)}</div>${pied}`, `/post/${postId}`);
    const carte = $('.post-carte', $('#modale-contenu'));
    if (carte) brancherPost(carte, p);
    brancherVideosImmersives($('#modale-contenu'));
    brancherCarrousels($('#modale-contenu'));
    brancherLecteursAudio($('#modale-contenu'));
    if (deplierCommentaires && carte) basculerCommentaires(carte, p.id);
  } catch (err) { toast(err.message); }
}

// Écoute en direct (Firestore) : démarrée une seule fois à la connexion, active
// tant que la session est ouverte. Le badge se met à jour immédiatement dès
// qu'une notification arrive, où que tu sois dans l'app ; la liste se
// rafraîchit toute seule si l'onglet Notifications est ouvert au même moment.
// Si l'app est en arrière-plan (onglet caché) et que l'autorisation a été
// donnée, une vraie notification système s'affiche aussi (rideau Android/iOS).
function demarrerEcouteNotifications() {
  if (etat.abonnementNotifs) etat.abonnementNotifs();
  let idsConnus = null;
  etat.abonnementNotifs = notifications.ecouter(etat.moi.id, (liste) => {
    const nonLues = liste.filter(n => !n.lu).length;
    $('#badge-notifs').textContent = nonLues;
    $('#badge-notifs').classList.toggle('cache', !nonLues);
    if (etat.ecranActuel === 'notifications') rendreNotifications(liste);

    if (idsConnus) {
      const nouvelles = liste.filter(n => !n.lu && !idsConnus.has(n.id));
      if (document.hidden) nouvelles.forEach(afficherNotificationSysteme);
    }
    idsConnus = new Set(liste.map(n => n.id));
  });
}

function afficherNotificationSysteme(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const notif = new Notification('KoZons', {
      body: `${n.acteurNom} ${LIBELLES_NOTIF[n.type] || n.texte}`,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: n.id
    });
    notif.onclick = () => { window.focus(); ouvrirActionNotification(n); notif.close(); };
  } catch { /* certains navigateurs mobiles n'autorisent la construction que via le Service Worker */ }
}

// Bandeau de demande d'autorisation (une seule fois, sur geste explicite de l'utilisateur)
function proposerNotificationsSysteme() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  if (localStorage.getItem('kozons_notif_refuse') === '1') return;
  setTimeout(() => $('#bandeau-notif').classList.remove('cache'), 2500);
}
$('#btn-notif-oui').addEventListener('click', async () => {
  $('#bandeau-notif').classList.add('cache');
  try { await Notification.requestPermission(); } catch {}
});
$('#btn-notif-non').addEventListener('click', () => {
  $('#bandeau-notif').classList.add('cache');
  localStorage.setItem('kozons_notif_refuse', '1');
});

async function chargerNotifications() {
  const z = $('#notifications-liste');
  if (!z.children.length) {
    z.innerHTML = '<p class="vide">Chargement...</p>';
    try { rendreNotifications(await notifications.lister(etat.moi.id)); }
    catch (err) { z.innerHTML = `<p class="vide">${err.message}</p>`; }
  }
  try { await notifications.toutMarquerLu(etat.moi.id); } catch (err) { toast(err.message); }
  // Les mises à jour suivantes (nouvelles notifs, passage en lu) arrivent
  // ensuite automatiquement via demarrerEcouteNotifications().
}

/* ================= RECHERCHE ================= */
let rechercheTimeout;
let categorieRecherche = 'TOUS';

function appliquerFiltreRecherche() {
  $$('#recherche-resultats > div').forEach(bloc => {
    bloc.classList.toggle('cache', categorieRecherche !== 'TOUS' && bloc.dataset.cat !== categorieRecherche);
  });
}

$$('[data-recherche-cat]').forEach(btn => btn.addEventListener('click', () => {
  categorieRecherche = btn.dataset.rechercheCat;
  $$('[data-recherche-cat]').forEach(b => b.classList.toggle('actif', b === btn));
  appliquerFiltreRecherche();
}));

$('#recherche-input').addEventListener('input', (e) => {
  clearTimeout(rechercheTimeout);
  const terme = e.target.value.trim();
  if (terme.length < 2) {
    ['#recherche-profils', '#recherche-canaux', '#recherche-posts', '#recherche-djassa'].forEach(s => $(s).innerHTML = '');
    return;
  }
  rechercheTimeout = setTimeout(() => lancerRecherche(terme), 350);
});

async function lancerRecherche(terme) {
  const zP = $('#recherche-profils'), zC = $('#recherche-canaux'), zPosts = $('#recherche-posts'), zD = $('#recherche-djassa');
  zP.innerHTML = zC.innerHTML = zPosts.innerHTML = zD.innerHTML = '<p class="vide">Recherche...</p>';
  appliquerFiltreRecherche();
  try {
    const [profs, canx, pos, djs] = await Promise.all([
      profils.rechercher(terme), canaux.rechercher(terme), posts.rechercherTexte(terme), djassa.rechercher(terme)
    ]);
    zP.innerHTML = profs.length ? profs.map(p => `
      <div class="canal-carte" data-uid="${p.id}">
        ${avatarHtml(p.avatarUrl, p.nomComplet, 'avatar')}
        <div class="canal-infos"><div class="canal-nom">${p.nomComplet}</div><div class="canal-membres">${p.ville || ''}</div></div>
      </div>`).join('') : '<p class="vide">Aucun profil trouvé.</p>';
    $$('.canal-carte', zP).forEach(el => el.addEventListener('click', () => { ouvrirProfil(el.dataset.uid); }));

    zC.innerHTML = canx.length ? canx.map(carteCanal).join('') : '<p class="vide">Aucun canal trouvé.</p>';
    $$('.canal-carte', zC).forEach(el => el.addEventListener('click', () => ouvrirCanal(el.dataset.id)));

    renderFil(zPosts, pos);

    zD.innerHTML = djs.length ? djs.map(a => `
      <div class="djassa-carte" data-id="${a.id}">
        ${a.image_url ? `<img src="${a.image_url}">` : `<div style="height:110px;background:var(--corail-clair);"></div>`}
        <div class="djassa-corps">
          <p class="djassa-titre">${escHtml(a.titre)}</p>
          <p class="djassa-prix">${Number(a.prix).toLocaleString('fr-FR')} ${a.devise}</p>
        </div>
      </div>`).join('') : '<p class="vide">Aucune annonce trouvée.</p>';
    $$('.djassa-carte', zD).forEach(el => el.addEventListener('click', () => ouvrirDetailDjassa(el.dataset.id)));
  } catch (err) { zP.innerHTML = `<p class="vide">${err.message}</p>`; }
}

/* ================= MESSAGES / CHAT ================= */
async function chargerConversations() {
  const z = $('#conversations-liste');
  z.innerHTML = '<p class="vide">Chargement...</p>';
  try {
    const data = await messages.conversations();
    z.innerHTML = data.length ? data.map(c => `
      <div class="conv-item" data-id="${c.id}" data-autre="${c.autre_id}" data-nom="${c.autre_nom}" data-avatar="${c.autre_avatar || ''}">
        <div class="conv-avatar-lien" data-uid="${c.autre_id}">${avatarHtml(c.autre_avatar, c.autre_nom, 'avatar')}</div>
        <div class="conv-corps">
          <div class="conv-nom conv-nom-lien" data-uid="${c.autre_id}">${c.autre_nom}</div>
          <div class="conv-dernier">${escHtml(c.dernier_message || 'Dites bonjour 👋')}</div>
        </div>
        ${c.non_lus ? `<span class="conv-badge">${c.non_lus}</span>` : ''}
      </div>`).join('') : '<p class="vide">Aucune conversation. Va sur un profil pour démarrer une discussion.</p>';
    $$('.conv-item', z).forEach(el => {
      // Clic sur la carte entière → ouvre le chat
      el.addEventListener('click', () => ouvrirChat(el.dataset.id, el.dataset.nom, el.dataset.avatar));
      // Clic sur la photo ou le nom → ouvre le profil
      $$('.conv-avatar-lien, .conv-nom-lien', el).forEach(lien => lien.addEventListener('click', (e) => {
        e.stopPropagation();
        ouvrirProfil(lien.dataset.uid);
      }));
    });
  } catch (err) { z.innerHTML = `<p class="vide">${err.message}</p>`; }
}

function ouvrirChat(conversationId, nom, avatar) {
  allerA('chat', false, conversationId);
  chargerContenuChat(conversationId, nom, avatar);
}

// Restaure une conversation à partir de son seul ID (rechargement de page sur
// /chat/{id}, ou retour du navigateur) : on retrouve l'autre participant.
async function ouvrirChatParId(conversationId) {
  try {
    const conv = await messages.obtenir(conversationId);
    if (!conv) return toast("Cette conversation n'existe plus.");
    etat.conversationCourante = conversationId;
    chargerContenuChat(conversationId, conv.autreNom, conv.autreAvatar);
  } catch (err) { toast(err.message); }
}

async function chargerContenuChat(conversationId, nom, avatar) {
  etat.conversationCourante = conversationId;
  $('#chat-entete').innerHTML = `${avatarHtml(avatar, nom, 'avatar avatar-sm')}<b>${nom}</b>`;
  const zone = $('#chat-messages');
  zone.innerHTML = '<p class="vide">Chargement...</p>';
  await messages.marquerLue(conversationId).catch(() => {});
  const historique = await messages.historique(conversationId);
  zone.innerHTML = historique.map(m => bulleMessage(m)).join('');
  zone.scrollTop = zone.scrollHeight;
  brancherLecteursAudio(zone);
  brancherMenuBulle(zone);

  if (etat.abonnementRealtime) etat.abonnementRealtime();
  etat.abonnementRealtime = messages.ecouter(conversationId, (payload) => {
    zone.insertAdjacentHTML('beforeend', bulleMessage(payload.new));
    brancherLecteursAudio(zone);
    zone.scrollTop = zone.scrollHeight;
  });
}

// Gestion de l'envoi avec indicateur "en cours" (⌛)
const origChatSubmit = () => {};  // placeholder — branché ci-dessous

function bulleMessage(m) {
  const estMoi = m.expediteur_id === etat.moi.id || m.expediteurId === etat.moi.id;
  const id = m.id || m.msg_id;
  const supprime = m.supprime;
  const modifie = m.modifie;

  let contenu;
  if (supprime) {
    contenu = `<span class="bulle-supprimee">🚫 Message supprimé</span>`;
  } else if (m.storyId) {
    const estVideo = m.storyTypeMedia === 'VIDEO';
    contenu = `
      <div class="bulle-story-apercu">
        ${m.storyApercu ? (estVideo ? `<video src="${m.storyApercu}" muted></video>` : `<img src="${m.storyApercu}">`) : `<div class="bulle-story-vide">🎬</div>`}
      </div>
      ${m.texte ? `<div class="bulle-story-reaction">${escHtml(m.texte)}</div>` : ''}`;
  } else if (m.typeMedia === 'IMAGE' && m.mediaUrl) {
    contenu = `<img src="${m.mediaUrl}" class="chat-media-img" loading="lazy">
      ${m.texte ? `<p style="margin:6px 0 0;">${escHtml(m.texte)}</p>` : ''}`;
  } else if (m.typeMedia === 'VIDEO' && m.mediaUrl) {
    contenu = `<video src="${m.mediaUrl}" class="chat-media-video" controls></video>
      ${m.texte ? `<p style="margin:6px 0 0;">${escHtml(m.texte)}</p>` : ''}`;
  } else if (m.typeMedia === 'AUDIO' && m.mediaUrl) {
    contenu = htmlLecteurAudio(m.mediaUrl, m.dureeAudioMs);
  } else {
    contenu = texteAvecLiens(m.texte);
  }

  const heure = m.dateEnvoi ? new Date(Number(m.dateEnvoi)).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
  const coches = estMoi && !supprime ? (m.lu ? '<span class="bulle-lu" title="Lu">✓✓</span>' : '<span class="bulle-livre" title="Livré">✓</span>') : '';
  const labelModifie = modifie && !supprime ? '<span class="bulle-modifie">modifié</span>' : '';

  return `<div class="bulle-wrapper ${estMoi ? 'moi' : 'autre'}" data-id="${id || ''}">
    <div class="bulle ${m.storyId ? 'bulle-story' : ''} ${estMoi ? 'moi' : 'autre'}">${contenu}</div>
    <div class="bulle-meta">${labelModifie}<span class="bulle-heure">${heure}</span>${coches}</div>
  </div>`;
}

// Menu modifier/supprimer (appui long ou double tap sur la bulle)
function brancherMenuBulle(zone) {
  let timerMenu = null;
  zone.addEventListener('pointerdown', (e) => {
    const bulle = e.target.closest('.bulle-wrapper.moi');
    if (!bulle) return;
    timerMenu = setTimeout(() => {
      timerMenu = null;
      const id = bulle.dataset.id;
      if (!id) return;
      const menu = document.createElement('div');
      menu.className = 'reaction-menu';
      menu.style.position = 'fixed';
      menu.style.right = '14px';
      menu.style.bottom = (window.innerHeight - e.clientY + 10) + 'px';
      menu.innerHTML = `<button data-action="modifier">✏️ Modifier</button><button data-action="supprimer">🗑️ Supprimer</button>`;
      document.body.appendChild(menu);
      const fermer = () => { menu.remove(); document.removeEventListener('click', fermer); };
      setTimeout(() => document.addEventListener('click', fermer), 10);
      $('[data-action="modifier"]', menu).addEventListener('click', async () => {
        fermer();
        const ancienTexte = bulle.querySelector('.bulle')?.textContent?.trim();
        const nouveau = prompt('Modifier le message :', ancienTexte);
        if (!nouveau || nouveau === ancienTexte) return;
        try {
          await messages.modifierMessage(etat.conversationCourante, id, nouveau);
          bulle.querySelector('.bulle').textContent = nouveau;
          if (!bulle.querySelector('.bulle-modifie')) {
            const meta = bulle.querySelector('.bulle-meta');
            meta?.insertAdjacentHTML('afterbegin', '<span class="bulle-modifie">modifié</span>');
          }
        } catch (err) { toast(err.message); }
      });
      $('[data-action="supprimer"]', menu).addEventListener('click', async () => {
        fermer();
        if (!confirm('Supprimer ce message ?')) return;
        try {
          await messages.supprimerMessage(etat.conversationCourante, id);
          bulle.querySelector('.bulle').innerHTML = '<span class="bulle-supprimee">🚫 Message supprimé</span>';
        } catch (err) { toast(err.message); }
      });
    }, 500);
  });
  zone.addEventListener('pointerup', () => { if (timerMenu) { clearTimeout(timerMenu); timerMenu = null; } });
  zone.addEventListener('pointerleave', () => { if (timerMenu) { clearTimeout(timerMenu); timerMenu = null; } });
}

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const texte = input.value.trim();
  const media = chatMediaEnAttente;
  if (!texte && !media || !etat.conversationCourante) return;
  input.value = '';
  const zone = $('#chat-messages');

  // Bulle provisoire "en cours d'envoi"
  const idProvisoire = `prov-${Date.now()}`;
  const apercuProvisoire = media ? (media.type.startsWith('video') ? `<video src="${URL.createObjectURL(media)}" muted></video>` : `<img src="${URL.createObjectURL(media)}">`) : '';
  zone.insertAdjacentHTML('beforeend', `
    <div class="bulle-wrapper moi" id="${idProvisoire}">
      ${apercuProvisoire ? `<div class="bulle moi chat-media-bulle">${apercuProvisoire}<div class="upload-barre-fond"><div class="upload-barre-remplie" id="prov-barre"></div></div></div>` : ''}
      ${texte ? `<div class="bulle moi">${escHtml(texte)}</div>` : ''}
      <div class="bulle-meta"><span class="bulle-heure">⌛</span></div>
    </div>`);
  zone.scrollTop = zone.scrollHeight;

  // Réinitialiser l'aperçu
  if (media) {
    chatMediaEnAttente = null;
    $('#chat-apercu-media').classList.add('cache');
    $('#chat-apercu-media').innerHTML = '';
    $('#chat-media-input').value = '';
  }

  try {
    let mediaUrl = null, typeMedia = 'TEXTE';
    if (media) {
      typeMedia = media.type.startsWith('video') ? 'VIDEO' : 'IMAGE';
      const barreEl = $('#prov-barre');
      const onProgression = barreEl ? (p) => barreEl.style.width = `${p}%` : null;
      mediaUrl = await stockage.televerser(media, 'messages', onProgression);
    }
    await messages.envoyer({
      conversationId: etat.conversationCourante, expediteurId: etat.moi.id,
      texte: texte || '', typeMedia, mediaUrl
    });
    document.getElementById(idProvisoire)?.remove();
  } catch (err) {
    document.getElementById(idProvisoire)?.remove();
    toast(err.message);
  }
});

// Envoi de médias (photo/vidéo) dans le chat
let chatMediaEnAttente = null;

$('#chat-media-input').addEventListener('change', (e) => {
  const fichier = e.target.files[0];
  if (!fichier) return;
  chatMediaEnAttente = fichier;
  const url = URL.createObjectURL(fichier);
  const estVideo = fichier.type.startsWith('video');
  const apercu = $('#chat-apercu-media');
  apercu.innerHTML = `
    <div class="chat-apercu-contenu">
      ${estVideo ? `<video src="${url}" muted controls></video>` : `<img src="${url}">`}
      <button type="button" id="chat-apercu-annuler">✕</button>
    </div>`;
  apercu.classList.remove('cache');
  $('#chat-apercu-annuler').addEventListener('click', () => {
    chatMediaEnAttente = null;
    apercu.classList.add('cache');
    apercu.innerHTML = '';
    e.target.value = '';
  });
});

// Envoi du message texte (avec ou sans média joint)
let enregistreurChat = null;
$('#chat-audio-btn').addEventListener('click', async () => {
  if (!etat.conversationCourante) return;
  const btnMic = $('#chat-audio-btn');
  const chrono = $('#chat-audio-chrono');
  if (!enregistreurChat) {
    try {
      enregistreurChat = creerEnregistreurAudio();
      await enregistreurChat.demarrer();
      btnMic.classList.add('actif');
      chrono.classList.remove('cache');
      const debut = Date.now();
      btnMic._chronoId = setInterval(() => chrono.textContent = formatDuree(Date.now() - debut), 500);
    } catch { toast("Impossible d'accéder au micro."); enregistreurChat = null; }
  } else {
    clearInterval(btnMic._chronoId);
    btnMic.classList.remove('actif'); chrono.classList.add('cache');
    const { blob, dureeMs } = await enregistreurChat.arreter();
    enregistreurChat = null;
    try {
      const url = await stockage.televerser(blob, 'messages');
      await messages.envoyer({
        conversationId: etat.conversationCourante, expediteurId: etat.moi.id,
        typeMedia: 'AUDIO', mediaUrl: url, dureeAudioMs: dureeMs
      });
    } catch (err) { toast(err.message); }
  }
});

async function demarrerConversationAvec(autreId, nom, avatar) {
  try {
    const convId = await messages.ouvrirAvec(autreId);
    allerA('messages');
    ouvrirChat(convId, nom, avatar);
  } catch (err) { toast(err.message); }
}

/* ================= PROFIL ================= */
async function chargerProfil(userId) {
  etat.profilAffiche = userId;
  const z = $('#profil-contenu');
  z.innerHTML = '<p class="vide">Chargement...</p>';
  try {
    const p = await profils.obtenir(userId);
    const estMoi = userId === etat.moi.id;
    let boutons = '';
    if (estMoi) {
      boutons = `<div class="profil-actions">
        <button class="bouton bouton-secondaire" id="btn-modifier-profil">Modifier le profil</button>
        <button class="bouton bouton-secondaire" id="btn-inviter">📣 Inviter</button>
        <button class="bouton bouton-secondaire" id="btn-deconnexion" style="color:var(--erreur);">Déconnexion</button>
      </div>`;
    } else {
      const abonne = await profils.estAbonne(etat.moi.id, userId);
      boutons = `<div class="profil-actions">
        <button class="bouton ${abonne ? 'bouton-secondaire' : 'bouton-principal'}" id="btn-abonnement">${abonne ? 'Abonné ✓' : 'Suivre'}</button>
        <button class="bouton bouton-secondaire" id="btn-message">Message</button>
      </div>`;
    }
    const btnPartageUrl = `https://kozons-69589.web.app/profil/${userId}`;
    if (estMoi) {
      boutons = `
        <div class="profil-btn-droite">
          <button class="bouton bouton-secondaire bouton-sm profil-btn-modifier" id="btn-modifier-profil">✏️ Modifier</button>
        </div>
        <div class="profil-actions-bas">
          <button class="bouton bouton-principal profil-btn-inviter" id="btn-inviter">↗️ Inviter à rejoindre KoZons</button>
        </div>`;
    } else {
      const abonne = await profils.estAbonne(etat.moi.id, userId);
      boutons = `
        <div class="profil-btn-droite">
          <button class="bouton ${abonne ? 'bouton-secondaire' : 'bouton-principal'} bouton-sm" id="btn-abonnement">${abonne ? 'Abonné ✓' : '+ Suivre'}</button>
        </div>
        <div class="profil-actions-bas">
          <button class="bouton bouton-secondaire profil-btn-message" id="btn-message">✉️ Message</button>
        </div>`;
    }

    z.innerHTML = `
      <div class="profil-couverture-zone">
        <div class="profil-couverture" style="${p.couvertureUrl ? `background-image:url('${p.couvertureUrl}');background-size:cover;background-position:center;` : 'background:linear-gradient(135deg,var(--corail),var(--vert));'}"></div>
        <button class="profil-partage-btn" onclick="navigator.share ? navigator.share({url:'${btnPartageUrl}'}) : navigator.clipboard.writeText('${btnPartageUrl}')">↗️</button>
        ${boutons.includes('btn-modifier-profil') ? `<div class="profil-btn-droite"><button class="bouton bouton-secondaire bouton-sm profil-btn-modifier" id="btn-modifier-profil">✏️ Modifier</button></div>` : boutons.split('</div>')[0] + '</div>'}
      </div>
      <div class="profil-avatar-zone">${avatarHtml(p.avatarUrl, p.nomComplet, 'profil-avatar')}${p.enLigne ? '<span class="point-en-ligne"></span>' : ''}</div>
      <div class="profil-infos">
        <h2 class="profil-nom">${p.nomComplet}${p.enLigne ? ' <span class="point-en-ligne-inline"></span>' : ''}</h2>
        ${p.pseudo ? `<p class="profil-pseudo">@${p.pseudo}</p>` : ''}
        ${p.bio ? `<p class="profil-bio">${texteAvecLiens(p.bio)}</p>` : ''}
        <div class="profil-stats">
          <div class="profil-stat profil-stat-lien" data-liste="abonnes"><b>${p.nbAbonnes || 0}</b> <span>Abonnés</span></div>
          <div class="profil-stat profil-stat-lien" data-liste="abonnements"><b>${p.nbAbonnements || 0}</b> <span>Abonnements</span></div>
        </div>
      </div>
      ${estMoi ? `<div class="profil-actions-bas"><button class="bouton bouton-principal profil-btn-inviter" id="btn-inviter">↗️ Inviter à rejoindre KoZons</button><button class="bouton profil-btn-deconnexion" id="btn-deconnexion">Déconnexion</button></div>` : `<div class="profil-actions-bas"><button class="bouton bouton-secondaire profil-btn-message" id="btn-message">✉️ Message</button></div>`}
      <div class="profil-onglets">
        <button class="profil-onglet-btn actif" data-profilonglet="publications">Feed</button>
        <button class="profil-onglet-btn" data-profilonglet="medias">Médias</button>
        <button class="profil-onglet-btn" data-profilonglet="enregistrements">Enregistrements</button>
      </div>
      <div id="profil-publications" style="margin-top:12px;"><p class="vide">Chargement...</p></div>
      <div id="profil-medias" class="cache" style="margin-top:12px;"></div>
      <div id="profil-enregistrements" class="cache" style="padding:0 16px;margin-top:12px;"><p class="vide">Aucun enregistrement audio pour le moment.</p></div>`;

    // Rebrancher les boutons
    if (estMoi) {
      $('#btn-modifier-profil')?.addEventListener('click', () => ouvrirEditionProfil(p));
      $('#btn-inviter')?.addEventListener('click', () => inviterDesAmis());
      $('#btn-deconnexion')?.addEventListener('click', () => auth.deconnexion());
    } else {
      $('#btn-abonnement')?.addEventListener('click', async (e) => {
        try {
          const dejaAbonne = e.target.textContent.includes('✓');
          if (dejaAbonne) await profils.neplussuivre(etat.moi.id, userId); else await profils.suivre(etat.moi.id, userId);
          chargerProfil(userId);
        } catch (err) { toast(err.message); }
      });
      $('#btn-message').addEventListener('click', () => demarrerConversationAvec(userId, p.nomComplet, p.avatarUrl));
    }

    $$('.profil-stat-lien', z).forEach(el => el.addEventListener('click', () => {
      ouvrirListeAbonnements(userId, el.dataset.liste, p.nomComplet);
    }));

    // Onglets : Feed / Médias / Enregistrements
    const zPub = $('#profil-publications'), zMed = $('#profil-medias'), zEnreg = $('#profil-enregistrements');
    posts.parAuteur(userId).then(liste => renderFil(zPub, liste))
      .catch(err => zPub.innerHTML = `<p class="vide">${err.message}</p>`);

    $$('.profil-onglet-btn', z).forEach(btn => btn.addEventListener('click', async () => {
      $$('.profil-onglet-btn', z).forEach(b => b.classList.toggle('actif', b === btn));
      const onglet = btn.dataset.profilonglet;
      zPub.classList.toggle('cache', onglet !== 'publications');
      zMed.classList.toggle('cache', onglet !== 'medias');
      zEnreg.classList.toggle('cache', onglet !== 'enregistrements');

      if (onglet === 'medias' && !zMed.dataset.charge) {
        zMed.dataset.charge = '1';
        zMed.innerHTML = '<p class="vide">Chargement...</p>';
        try {
          const medias = await posts.medias(userId);
          zMed.innerHTML = medias.length ? `<div class="medias-grille">
            ${medias.map(m => `<div class="media-vignette">${m.typeMedia === 'VIDEO' ? `<video src="${m.mediaUrl}" muted></video><span class="media-badge-video">▶</span>` : `<img src="${m.mediaUrl}">`}</div>`).join('')}
          </div>` : '<p class="vide">Aucun média publié.</p>';
        } catch (err) { zMed.innerHTML = `<p class="vide">${err.message}</p>`; }
      }
      if (onglet === 'enregistrements' && !zEnreg.dataset.charge) {
        zEnreg.dataset.charge = '1';
        zEnreg.innerHTML = '<p class="vide">Chargement...</p>';
        try {
          const audios = (await posts.parAuteur(userId)).filter(p => p.typeMedia === 'AUDIO' && p.mediaUrl);
          zEnreg.innerHTML = audios.length ? audios.map(a => `
            <div class="post-carte" style="margin-bottom:12px;">
              <div class="post-entete">
                ${avatarHtml(p.avatarUrl, p.nomComplet, 'avatar avatar-sm')}
                <div><div class="post-auteur">${p.nomComplet}</div><div class="post-meta">${tempsRelatif(a.dateCreation)}</div></div>
              </div>
              ${htmlLecteurAudio(a.mediaUrl, a.dureeAudioMs)}
            </div>`).join('') : '<p class="vide">Aucun enregistrement audio.</p>';
          brancherLecteursAudio(zEnreg);
        } catch (err) { zEnreg.innerHTML = `<p class="vide">${err.message}</p>`; }
      }
    }));
  } catch (err) { z.innerHTML = `<p class="vide">${err.message}</p>`; }
}

async function ouvrirListeAbonnements(userId, type, nomProprietaire) {
  const titre = type === 'abonnes' ? 'Abonnés' : 'Abonnements';
  ouvrirModale(`<h3>${titre}</h3><div id="liste-abonnements-contenu"><p class="vide">Chargement...</p></div>`);
  const zone = $('#liste-abonnements-contenu');
  try {
    const liste = type === 'abonnes' ? await profils.listerAbonnes(userId) : await profils.listerAbonnements(userId);
    zone.innerHTML = liste.length ? `<div class="canaux-liste">
      ${liste.map(p => `
        <div class="canal-carte" data-uid="${p.id}">
          ${avatarHtml(p.avatarUrl, p.nomComplet, 'avatar')}
          <div class="canal-infos"><div class="canal-nom">${p.nomComplet || 'Utilisateur'}</div><div class="canal-membres">${p.ville || ''}</div></div>
        </div>`).join('')}
    </div>` : `<p class="vide">${nomProprietaire} n'a ${type === 'abonnes' ? "pas encore d'abonné" : 'encore suivi personne'}.</p>`;
    $$('.canal-carte', zone).forEach(el => el.addEventListener('click', () => {
      fermerModale();
      ouvrirProfil(el.dataset.uid);
    }));
  } catch (err) { zone.innerHTML = `<p class="vide">${err.message}</p>`; }
}

async function ouvrirListeReactions(postId) {
  ouvrirModale(`<h3>Réactions</h3><div id="liste-reactions-filtres" class="fil-filtres cache"></div><div id="liste-reactions-contenu"><p class="vide">Chargement...</p></div>`);
  const zone = $('#liste-reactions-contenu');
  const zoneFiltres = $('#liste-reactions-filtres');
  try {
    const items = await posts.listerReactions(postId);
    if (!items.length) { zone.innerHTML = '<p class="vide">Personne n\'a encore réagi.</p>'; return; }

    const parType = {};
    items.forEach(i => { (parType[i.type] ||= []).push(i); });
    const types = Object.keys(parType);

    const rendre = (filtre) => {
      const liste = filtre === 'TOUS' ? items : parType[filtre] || [];
      zone.innerHTML = `<div class="canaux-liste">
        ${liste.map(i => `
          <div class="canal-carte" data-uid="${i.uid}">
            ${avatarHtml(i.profil.avatarUrl, i.profil.nomComplet, 'avatar')}
            <div class="canal-infos"><div class="canal-nom">${i.profil.nomComplet || 'Utilisateur'}</div></div>
            <span style="font-size:1.2rem;">${EMOJIS[i.type] || '👍'}</span>
          </div>`).join('')}
      </div>`;
      $$('.canal-carte', zone).forEach(el => el.addEventListener('click', () => {
        fermerModale();
        ouvrirProfil(el.dataset.uid);
      }));
    };

    if (types.length > 1) {
      zoneFiltres.classList.remove('cache');
      zoneFiltres.innerHTML = `<button class="filtre-btn actif" data-type-reaction="TOUS">Tous ${items.length}</button>
        ${types.map(t => `<button class="filtre-btn" data-type-reaction="${t}">${EMOJIS[t] || ''} ${parType[t].length}</button>`).join('')}`;
      $$('[data-type-reaction]', zoneFiltres).forEach(btn => btn.addEventListener('click', () => {
        $$('[data-type-reaction]', zoneFiltres).forEach(b => b.classList.toggle('actif', b === btn));
        rendre(btn.dataset.typeReaction);
      }));
    }
    rendre('TOUS');
  } catch (err) { zone.innerHTML = `<p class="vide">${err.message}</p>`; }
}

function inviterDesAmis() {
  const texte = "Rejoins-moi sur KoZons — on parle, on écoute, on kiffe 🔥 Télécharge l'app ici :";
  const url = "https://github.com/armeles7/kozons-releases/releases/latest/download/Kozons.apk";
  if (navigator.share) {
    navigator.share({ title: 'KoZons', text: texte, url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(`${texte} ${url}`);
    toast('Message d\'invitation copié !');
  }
}

function ouvrirEditionProfil(p) {
  ouvrirModale(`
    <h3 style="font-size:1.15rem;font-weight:800;margin:0 0 20px;">Modifier le profil</h3>
    <form id="form-edition-profil">

      <div class="edit-avatar-zone">
        <div class="edit-avatar-apercu">${avatarHtml(p.avatarUrl, p.nomComplet, 'profil-avatar')}</div>
        <label class="edit-lien-orange" for="edit-avatar-fichier">Changer l'avatar</label>
        <input type="file" id="edit-avatar-fichier" accept="image/*" class="cache">
      </div>
      <label class="edit-lien-orange" for="edit-couverture-fichier" style="display:block;margin:10px 0 18px;">Changer la couverture</label>
      <input type="file" id="edit-couverture-fichier" accept="image/*" class="cache">

      <div class="edit-champ">
        <label class="edit-label">Nom complet</label>
        <input type="text" id="edit-nom" class="edit-input" value="${p.nomComplet || ''}">
      </div>
      <div class="edit-champ">
        <label class="edit-label">Pseudo (@)</label>
        <input type="text" id="edit-pseudo" class="edit-input" value="${p.pseudo || ''}" placeholder="@">
      </div>
      <div class="edit-champ">
        <input type="text" id="edit-profession" class="edit-input" value="${p.profession || ''}" placeholder="Profession / statut">
      </div>
      <div class="edit-champ">
        <textarea id="edit-bio" class="edit-input" rows="3" maxlength="160" placeholder="Bio">${p.bio || ''}</textarea>
        <span class="edit-compteur" id="edit-bio-compteur">${(p.bio || '').length}/160</span>
      </div>
      <div class="edit-champ">
        <input type="text" id="edit-ville" class="edit-input" value="${p.ville || ''}" placeholder="Ville">
      </div>
      <div class="edit-champ">
        <input type="text" id="edit-lien" class="edit-input" value="${p.lienExterne || ''}" placeholder="Lien externe">
      </div>

      <div class="edit-boutons">
        <button type="button" class="edit-btn-annuler" id="edit-annuler">Annuler</button>
        <button type="submit" class="edit-btn-enregistrer">Enregistrer</button>
      </div>
    </form>`);

  // Compteur bio
  $('#edit-bio').addEventListener('input', () => {
    $('#edit-bio-compteur').textContent = `${$('#edit-bio').value.length}/160`;
  });
  // Annuler
  $('#edit-annuler').addEventListener('click', fermerModale);
  // Prévisualiser l'avatar choisi
  $('#edit-avatar-fichier').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const url = URL.createObjectURL(f);
    $('.edit-avatar-apercu img, .edit-avatar-apercu > div', $('#modale-contenu'));
    const imgEl = $('.profil-avatar', $('#modale-contenu'));
    if (imgEl) imgEl.src = url;
  });

  $('#form-edition-profil').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('.edit-btn-enregistrer'); btn.disabled = true; btn.textContent = '...';
    try {
      let avatarUrl = p.avatarUrl;
      let couvertureUrl = p.couvertureUrl;
      const fichierAvatar = $('#edit-avatar-fichier').files[0];
      const fichierCouv = $('#edit-couverture-fichier').files[0];

      if (fichierAvatar) {
        btn.textContent = 'Envoi photo...';
        const { onProgression, retirer } = creerBarreProgression($('#modale-contenu'));
        avatarUrl = await stockage.televerser(fichierAvatar, `avatars/${etat.moi.id}`, onProgression);
        retirer();
      }
      if (fichierCouv) {
        btn.textContent = 'Envoi couverture...';
        const { onProgression, retirer } = creerBarreProgression($('#modale-contenu'));
        couvertureUrl = await stockage.televerser(fichierCouv, `couvertures/${etat.moi.id}`, onProgression);
        retirer();
      }

      await profils.modifier(etat.moi.id, {
        nomComplet: $('#edit-nom').value.trim(),
        pseudo: $('#edit-pseudo').value.trim().replace(/^@/, ''),
        profession: $('#edit-profession').value.trim(),
        bio: $('#edit-bio').value.trim(),
        ville: $('#edit-ville').value.trim(),
        lienExterne: $('#edit-lien').value.trim(),
        avatarUrl, couvertureUrl
      });

      // Créer un post pour la nouvelle photo de profil
      if (fichierAvatar && avatarUrl) {
        await posts.publier({
          auteurId: etat.moi.id, auteurNom: etat.moi.nomComplet, auteurAvatar: avatarUrl,
          texte: `${etat.moi.nomComplet} a mis à jour sa photo de profil.`,
          typeMedia: 'IMAGE', mediaUrl: avatarUrl, medias: null,
          dureeAudioMs: null, couleurFond: null, channelId: null, channelNom: null
        });
      }
      // Créer un post pour la nouvelle photo de couverture
      if (fichierCouv && couvertureUrl) {
        await posts.publier({
          auteurId: etat.moi.id, auteurNom: etat.moi.nomComplet, auteurAvatar: avatarUrl || p.avatarUrl,
          texte: `${etat.moi.nomComplet} a mis à jour sa photo de couverture.`,
          typeMedia: 'IMAGE', mediaUrl: couvertureUrl, medias: null,
          dureeAudioMs: null, couleurFond: null, channelId: null, channelNom: null
        });
      }

      etat.moi = await profils.obtenir(etat.moi.id);
      fermerModale(); toast('Profil mis à jour !');
      chargerProfil(etat.moi.id);
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Enregistrer'; }
  });
}

/* ================= DÉMARRAGE ================= */
async function ouvrirLienPartage() {
  const m = location.pathname.match(/^\/post\/([^/]+)/);
  if (!m) return;
  await ouvrirPost(m[1], { avecTelechargement: true });
}

/* ================= PWA (installation + hors-ligne) ================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

let evenementInstallDiffere = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  evenementInstallDiffere = e;
  if (localStorage.getItem('kozons_install_refuse') === '1') return;
  $('#bandeau-install').classList.remove('cache');
});

$('#btn-install-oui').addEventListener('click', async () => {
  $('#bandeau-install').classList.add('cache');
  if (!evenementInstallDiffere) return;
  evenementInstallDiffere.prompt();
  await evenementInstallDiffere.userChoice;
  evenementInstallDiffere = null;
});

$('#btn-install-non').addEventListener('click', () => {
  $('#bandeau-install').classList.add('cache');
  localStorage.setItem('kozons_install_refuse', '1');
});

window.addEventListener('appinstalled', () => {
  $('#bandeau-install').classList.add('cache');
  toast('KoZons est installé ! 🎉');
});

async function demarrer() {
  auth.onChange((session) => { session ? demarrerSession(session) : arreterSession(); });
  const session = await auth.session();
  $('#ecran-chargement').style.opacity = '0';
  setTimeout(() => $('#ecran-chargement').remove(), 400);
  if (session) { await demarrerSession(session); await ouvrirLienPartage(); }
  else $('#ecran-auth').classList.remove('cache');
}
demarrer();
