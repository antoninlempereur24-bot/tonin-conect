const socket = io();

// État utilisateur actuel (modifiable ou récupéré)
const currentUser = {
    username: 'Antonin',
    avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Antonin'
};

let currentShorts = [];
let activeCommentShortId = null;

// Éléments du DOM
const openShortsBtn = document.getElementById('open-shorts-btn');
const shortsModal = document.getElementById('shorts-modal');
const closeShortsBtn = document.getElementById('close-shorts-btn');
const shortsContainer = document.getElementById('shorts-container');

const openPostModalBtn = document.getElementById('open-post-modal-btn');
const postModal = document.getElementById('post-modal');
const cancelPostBtn = document.getElementById('cancel-post-btn');
const postShortForm = document.getElementById('post-short-form');

const commentsModal = document.getElementById('comments-modal');
const closeCommentsBtn = document.getElementById('close-comments-btn');
const commentsList = document.getElementById('comments-list');
const commentForm = document.getElementById('comment-form');
const commentInput = document.getElementById('comment-input');

// Ouvrir / Fermer la vue Shorts
openShortsBtn.addEventListener('click', () => {
    shortsModal.classList.remove('hidden');
    fetchShorts();
});

closeShortsBtn.addEventListener('click', () => {
    shortsModal.classList.add('hidden');
    // Pause toutes les vidéos lors de la fermeture
    document.querySelectorAll('.short-video').forEach(vid => vid.pause());
});

// Gestion Modal Publication
openPostModalBtn.addEventListener('click', () => {
    postModal.classList.remove('hidden');
});

cancelPostBtn.addEventListener('click', () => {
    postModal.classList.add('hidden');
    postShortForm.reset();
});

postShortForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const videoUrl = document.getElementById('short-url').value;
    const title = document.getElementById('short-title').value;
    const description = document.getElementById('short-desc').value;

    try {
        const response = await fetch('/api/shorts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                videoUrl,
                title,
                description,
                author: currentUser.username,
                avatar: currentUser.avatar
            })
        });

        if (response.ok) {
            postModal.classList.add('hidden');
            postShortForm.reset();
            fetchShorts();
        } else {
            alert('Erreur lors de la publication de la vidéo.');
        }
    } catch (err) {
        console.error(err);
    }
});

// Récupérer les Shorts
async function fetchShorts() {
    try {
        const res = await fetch('/api/shorts');
        currentShorts = await res.json();
        renderShorts();
    } catch (err) {
        console.error(err);
    }
}

// Rendu des Shorts
function renderShorts() {
    shortsContainer.innerHTML = '';
    if (currentShorts.length === 0) {
        shortsContainer.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100%;color:white;">Aucun Short pour le moment. Soyez le premier à en poster un ! 💎</div>';
        return;
    }

    currentShorts.forEach(short => {
        const isLiked = short.likedBy && short.likedBy.includes(currentUser.username);
        const isOwner = short.author === currentUser.username;

        const card = document.createElement('div');
        card.className = 'short-card';
        card.dataset.id = short.id;

        card.innerHTML = `
            <video class="short-video" src="${short.videoUrl}" loop playsinline></video>
            
            <div class="short-overlay">
                <div class="short-author-info">
                    <img src="${short.avatar}" alt="${short.author}">
                    <span>${short.author}</span>
                </div>
                ${short.title ? `<div class="short-title">${escapeHtml(short.title)}</div>` : ''}
                ${short.description ? `<div class="short-description">${escapeHtml(short.description)}</div>` : ''}
            </div>

            <div class="short-actions">
                <button class="action-btn like-btn ${isLiked ? 'liked' : ''}" data-id="${short.id}">
                    <i class="fas fa-heart"></i>
                    <span>${short.likes}</span>
                </button>
                <button class="action-btn comment-btn" data-id="${short.id}">
                    <i class="fas fa-comment"></i>
                    <span>${short.comments.length}</span>
                </button>
                ${isOwner ? `
                <button class="action-btn delete-btn" data-id="${short.id}" title="Supprimer">
                    <i class="fas fa-trash"></i>
                </button>` : ''}
            </div>
        `;

        shortsContainer.appendChild(card);
    });

    setupVideoObserver();
    setupShortActions();
}

// Observer pour lecture automatique de la vidéo visible à l'écran (Style TikTok)
function setupVideoObserver() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const video = entry.target.querySelector('video');
            if (!video) return;

            if (entry.isIntersecting) {
                video.play().catch(() => {});
            } else {
                video.pause();
                video.currentTime = 0;
            }
        });
    }, { threshold: 0.6 });

    document.querySelectorAll('.short-card').forEach(card => {
        observer.observe(card);
        const video = card.querySelector('video');
        video.addEventListener('click', () => {
            if (video.paused) {
                video.play();
            } else {
                video.pause();
            }
        });
    });
}

// Gestion des interactions (Like, Commentaire, Suppression)
function setupShortActions() {
    document.querySelectorAll('.like-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = btn.dataset.id;
            await fetch(`/api/shorts/${id}/like`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: currentUser.username })
            });
        });
    });

    document.querySelectorAll('.comment-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeCommentShortId = btn.dataset.id;
            openComments(activeCommentShortId);
        });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (confirm('Voulez-vous vraiment supprimer ce Short ?')) {
                const id = btn.dataset.id;
                await fetch(`/api/shorts/${id}`, { method: 'DELETE' });
            }
        });
    });
}

// Gestion des commentaires
function openComments(shortId) {
    const short = currentShorts.find(s => s.id === shortId);
    if (!short) return;

    renderComments(short.comments);
    commentsModal.classList.remove('hidden');
}

function renderComments(comments) {
    commentsList.innerHTML = '';
    if (comments.length === 0) {
        commentsList.innerHTML = '<p style="text-align:center;color:#888;margin-top:20px;">Aucun commentaire pour l\'instant.</p>';
        return;
    }

    comments.forEach(c => {
        const item = document.createElement('div');
        item.className = 'comment-item';
        item.innerHTML = `
            <div class="comment-author">${escapeHtml(c.author)}</div>
            <div class="comment-text">${escapeHtml(c.text)}</div>
        `;
        commentsList.appendChild(item);
    });
}

closeCommentsBtn.addEventListener('click', () => {
    commentsModal.classList.add('hidden');
    activeCommentShortId = null;
});

commentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeCommentShortId) return;
    const text = commentInput.value;

    const res = await fetch(`/api/shorts/${activeCommentShortId}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, author: currentUser.username })
    });

    if (res.ok) {
        commentInput.value = '';
        const updated = await res.json();
        currentShorts = currentShorts.map(s => s.id === updated.id ? updated : s);
        renderComments(updated.comments);
        // Mettre à jour le compteur sur la carte
        const card = document.querySelector(`.short-card[data-id="${updated.id}"]`);
        if (card) {
            card.querySelector('.comment-btn span').textContent = updated.comments.length;
        }
    }
});

// WebSocket en temps réel
socket.on('new-short', (short) => {
    currentShorts.unshift(short);
    if (!shortsModal.classList.contains('hidden')) {
        renderShorts();
    }
});

socket.on('delete-short', (id) => {
    currentShorts = currentShorts.filter(s => s.id !== id);
    const card = document.querySelector(`.short-card[data-id="${id}"]`);
    if (card) card.remove();
});

socket.on('update-short', (updatedShort) => {
    currentShorts = currentShorts.map(s => s.id === updatedShort.id ? updatedShort : s);
    const card = document.querySelector(`.short-card[data-id="${updatedShort.id}"]`);
    if (card) {
        const likeBtn = card.querySelector('.like-btn');
        likeBtn.querySelector('span').textContent = updatedShort.likes;
        if (updatedShort.likedBy.includes(currentUser.username)) {
            likeBtn.classList.add('liked');
        } else {
            likeBtn.classList.remove('liked');
        }
        card.querySelector('.comment-btn span').textContent = updatedShort.comments.length;

        if (activeCommentShortId === updatedShort.id) {
            renderComments(updatedShort.comments);
        }
    }
});

function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
}