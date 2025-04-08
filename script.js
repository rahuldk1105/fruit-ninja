// Get references to the HTML elements
const videoElement = document.getElementById('webcam');
const canvasElement = document.getElementById('outputCanvas');
// Get 2D drawing context, handle potential errors
let canvasCtx = null;
if (canvasElement && canvasElement.getContext) {
    canvasCtx = canvasElement.getContext('2d');
} else {
    console.error("Failed to get 2D context from canvas element.");
    // Optionally display an error message to the user
}
const containerElement = document.getElementById('game-area'); // Reference to the game area
const loadingElement = document.getElementById('loading-message');
const loadingScreen = document.getElementById('loading-screen');
const introScreen = document.getElementById('intro-screen');
const gameOverScreen = document.getElementById('game-over-screen');
const gameUiElement = document.getElementById('game-ui');
const startButton = document.getElementById('start-button');
const playAgainButton = document.getElementById('play-again-button');
const fullscreenButton = document.getElementById('fullscreen-button');
const scoreDisplay = document.getElementById('score-display');
const timerDisplay = document.getElementById('timer-display');
const finalScoreDisplay = document.getElementById('final-score');
const highScoreDisplay = document.getElementById('high-score');
const newHighScoreMsg = document.getElementById('new-high-score-msg');

// --- Game State ---
let gameState = 'LOADING'; // LOADING, INTRO, PLAYING, GAME_OVER

// --- Global Variables ---
let detector;
let lastKnownPosition = null;
const trailLength = 10; // Max number of points in the trail effect
let trailPoints = []; // Array to store trail points {x, y, opacity}
let frameCount = 0; // Frame counter

// --- Configuration for Hand Detection Model ---
const modelConfig = {
    runtime: 'mediapipe', // Use MediaPipe's own WASM runtime
    modelType: 'lite',
    maxHands: 1
};

// --- Confidence Thresholds ---
const detectionConfidence = 0.5; // Confidence for overall hand detection

// --- Define Hand Connections Manually ---
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // Thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // Index finger
  [0, 9], [9, 10], [10, 11], [11, 12], // Middle finger
  [0, 13], [13, 14], [14, 15], [15, 16], // Ring finger
  [0, 17], [17, 18], [18, 19], [19, 20], // Pinky finger
  [5, 9], [9, 13], [13, 17] // Palm
];

// --- Fruit Simulation Variables & Constants ---
const gravity = 0.15;
const fruitSpawnProbability = 0.07; // Normal spawn rate
const fruitTypes = [
    { type: 'apple', color: 'rgba(255, 50, 50, 1)', radius: 20 },
    { type: 'banana', color: 'rgba(255, 225, 50, 1)', radius: 18 },
    { type: 'watermelon', color: 'rgba(50, 200, 50, 1)', radius: 25 }
];
let fruits = [];

// --- Slicing, Scoring & Particle Variables ---
let score = 0;
let highScore = 0;
let particles = [];
const particleLife = 40;
const particleGravity = 0.08;
const particleDrag = 0.97;
let lastSliceTime = 0;
let comboCounter = 0;
const comboTimeWindow = 600;
const baseScore = 10;
const comboBonusMultiplier = 5;

// --- Timer Variables ---
const GAME_DURATION_SECONDS = 30;
let timerInterval = null;
let timeLeft = GAME_DURATION_SECONDS;
let gameStartTime = 0;

// --- Tone.js Setup (Still Commented Out) ---
const sliceSynth = null;


// --- Function to Initialize TFJS Backend (Prefer WebGL) ---
async function initializeTfjsBackend() {
    console.log("Initializing TFJS Backend (though runtime is MediaPipe)...");
    // Check if tf is globally available
    if (typeof tf === 'undefined') {
        console.warn("TensorFlow.js (tf) not found. Skipping backend initialization.");
        return;
    }
    try {
        await tf.ready();
        const backend = 'webgl';
        await tf.setBackend(backend);
        console.log(`TFJS backend set successfully to: ${backend}`);
        await tf.ready();
    } catch (error) {
        console.warn(`Failed to set TFJS backend to webgl, falling back to CPU. Error: ${error}`);
        try {
            await tf.setBackend('cpu');
            console.log("TFJS backend set successfully to: cpu");
            await tf.ready();
        } catch (cpuError) {
            console.error("FATAL - Failed to set TFJS backend to CPU.", cpuError);
            // Don't throw error here, allow mediapipe runtime to potentially still work
        }
    }
    console.log("TFJS Backend Initialized (or attempted).");
}

// --- Helper function for getUserMedia with Timeout ---
async function getCameraStream(constraints, timeoutMs = 10000) {
    console.log(`Requesting camera stream with timeout ${timeoutMs}ms...`);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
         throw new Error("getUserMedia is not supported.");
    }
    const mediaPromise = navigator.mediaDevices.getUserMedia(constraints);
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`getUserMedia timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
        const stream = await Promise.race([mediaPromise, timeoutPromise]);
        console.log("getUserMedia successful within timeout.");
        return stream;
    } catch (error) {
        console.error("Error in getCameraStream:", error.name, error.message);
        if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') { throw new Error('Camera not found.'); }
        else if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') { throw new Error('Camera permission denied.'); }
        else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') { throw new Error('Camera is already in use or hardware error.'); }
        else { throw new Error(`Failed to access camera: ${error.name}`); }
    }
}


// --- Main Setup Function: Initializes Camera and Model ---
async function setupCameraAndDetector() {
    console.log("Starting setupCameraAndDetector...");
    updateLoadingMessage("Initializing Backend...");
    gameState = 'LOADING';
    let stream;
    try {
        await initializeTfjsBackend(); // Attempt backend init
        updateLoadingMessage("Requesting camera access...");
        stream = await getCameraStream({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false }, 10000);
        if (!stream || !stream.active) { throw new Error("Failed to get a valid camera stream."); }
        console.log("DEBUG: Stream seems valid and active.");

        if (!videoElement) throw new Error("Video element not found");
        videoElement.srcObject = stream;
        console.log("stream assigned to videoElement.srcObject.");
        try { await videoElement.play(); console.log("Called videoElement.play() successfully."); } // Try awaiting play here again
        catch (playError) { console.warn("Error calling videoElement.play() (continuing):", playError); } // Warn instead of error

        updateLoadingMessage("Setting up dimensions (assuming 640x480)...");
        console.log("Skipping metadata wait, assuming dimensions...");
        const videoWidth = 640; const videoHeight = 480;
        console.log("Setting dimensions...");
        videoElement.width = videoWidth; videoElement.height = videoHeight;
        if (!canvasElement) throw new Error("Canvas element not found");
        canvasElement.width = videoWidth; canvasElement.height = videoHeight;
        console.log(`Video/Canvas dimensions ASSUMED set to: ${videoWidth}x${videoHeight}`);

        console.log("Loading hand detection model (MediaPipe runtime)...");
        updateLoadingMessage("Loading Hand Pose Model...");
        if (typeof handPoseDetection === 'undefined') { throw new ReferenceError("handPoseDetection object not found..."); }
        const detectorConfig = {
             runtime: 'mediapipe', modelType: 'lite', maxHands: 1,
             solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240'
        };
        console.log("Config being passed to createDetector:", JSON.stringify(detectorConfig));
        console.log("Attempting to create detector using string 'MediaPipeHands'...");
        detector = await handPoseDetection.createDetector('MediaPipeHands', detectorConfig);
        console.log("Model loaded successfully (MediaPipe runtime).");
        updateLoadingMessage("Model loaded. Ready.");
        highScore = parseInt(localStorage.getItem('handSliceHighScore') || '0');
        console.log("High score loaded:", highScore);
        console.log("Setup complete.");
        setGameState('INTRO');
        console.log("Starting prediction loop.");
        predictHands();
    } catch (error) {
        console.error("!!!! CRITICAL ERROR DURING setupCameraAndDetector !!!!", error.name, error.message, error);
        updateLoadingMessage(`Setup Error: ${error.message}. Check console & permissions.`);
        alert(`Failed to initialize: ${error.message}\n\nPlease check console, ensure camera permissions are allowed, and no other app is using the camera.`);
        setTimeout(logVideoState, 500); // Log video state on error
    }
}

// --- Game State Management ---
function setGameState(newState) {
     console.log(`DEBUG: Changing state from ${gameState} to ${newState}`);
     gameState = newState;
     // Ensure elements exist before toggling class
     if (loadingScreen) loadingScreen.classList.toggle('hidden', gameState !== 'LOADING');
     if (introScreen) introScreen.classList.toggle('hidden', gameState !== 'INTRO');
     if (gameOverScreen) gameOverScreen.classList.toggle('hidden', gameState !== 'GAME_OVER');
     if (gameUiElement) gameUiElement.classList.toggle('hidden', gameState !== 'PLAYING');
     console.log(`DEBUG: UI elements hidden/shown for state: ${newState}`);
     if (gameState === 'PLAYING') { startGame(); }
     if (gameState === 'GAME_OVER') { endGame(); }
     if (gameState === 'INTRO') {
         if(scoreDisplay) scoreDisplay.textContent = `Score: 0`;
         if(timerDisplay) timerDisplay.textContent = `Time: ${GAME_DURATION_SECONDS}`;
     }
}
function updateLoadingMessage(message) { if (loadingElement) { loadingElement.textContent = message; } }

// --- Game Flow Functions ---
function startGame() {
    console.log("Starting game...");
    score = 0; timeLeft = GAME_DURATION_SECONDS; fruits = []; particles = [];
    comboCounter = 0; lastSliceTime = 0;
    if(scoreDisplay) scoreDisplay.textContent = `Score: ${score}`;
    if(timerDisplay) timerDisplay.textContent = `Time: ${timeLeft}`;
    if(newHighScoreMsg) newHighScoreMsg.classList.add('hidden');
    gameStartTime = Date.now();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
}
function updateTimer() {
    const elapsedSeconds = Math.floor((Date.now() - gameStartTime) / 1000);
    timeLeft = Math.max(0, GAME_DURATION_SECONDS - elapsedSeconds);
    if(timerDisplay) timerDisplay.textContent = `Time: ${timeLeft}`;
    if (timeLeft <= 0) { setGameState('GAME_OVER'); }
}
function endGame() {
    console.log("Ending game...");
    clearInterval(timerInterval); timerInterval = null;
    if(finalScoreDisplay) finalScoreDisplay.textContent = `Your Score: ${score}`;
    if (score > highScore) {
        console.log("New High Score!", score); highScore = score;
        localStorage.setItem('handSliceHighScore', highScore.toString());
        if(newHighScoreMsg) newHighScoreMsg.classList.remove('hidden');
    } else {
        if(newHighScoreMsg) newHighScoreMsg.classList.add('hidden');
    }
    if(highScoreDisplay) highScoreDisplay.textContent = `High Score: ${highScore}`;
}

// --- Fullscreen Logic ---
function toggleFullScreen() {
  // Check if containerElement exists
  if (!containerElement) {
      console.error("Cannot enter fullscreen: Game area element not found.");
      return;
  }
  if (!document.fullscreenElement) {
    // Target the game-area container
    containerElement.requestFullscreen()
      .then(() => {
          if (fullscreenButton) {
              fullscreenButton.innerHTML = '<i class="lucide lucide-minimize"></i>';
              fullscreenButton.title = "Exit Fullscreen";
          }
      })
      .catch(err => {
        alert(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
      });
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen()
       .then(() => {
           if (fullscreenButton) {
               fullscreenButton.innerHTML = '<i class="lucide lucide-maximize"></i>';
               fullscreenButton.title = "Enter Fullscreen";
           }
       });
    }
  }
}
// --- Event Listeners ---
function setupEventListeners() {
     // Ensure elements exist before adding listeners
     if(startButton) { startButton.addEventListener('click', () => { console.log("DEBUG: Start button clicked!"); setGameState('PLAYING'); }); console.log("DEBUG: Start button listener attached."); }
     else { console.error("DEBUG: Start button not found!"); }
     if(playAgainButton) { playAgainButton.addEventListener('click', () => setGameState('PLAYING')); console.log("DEBUG: Play Again listener attached."); }
     else { console.error("DEBUG: Play Again button not found!"); }
     if(fullscreenButton) { fullscreenButton.addEventListener('click', toggleFullScreen); console.log("DEBUG: Fullscreen listener attached."); }
     else { console.error("DEBUG: Fullscreen button not found!"); }
}

// --- Fruit Functions ---
function spawnFruit() {
    if (!canvasElement || !canvasElement.width || !canvasElement.height) return;
    const typeIndex = Math.floor(Math.random() * fruitTypes.length);
    const typeInfo = fruitTypes[typeIndex];
    const fruit = {
        x: canvasElement.width * (0.2 + Math.random() * 0.6),
        y: canvasElement.height + typeInfo.radius + 10,
        vx: (Math.random() - 0.5) * 3,
        vy: -9 - Math.random() * 6,
        radius: typeInfo.radius,
        color: typeInfo.color,
        type: typeInfo.type
    };
    fruits.push(fruit);
    // console.log("DEBUG: Spawned fruit:", fruit.type); // Keep commented unless needed
}
function updateFruits() {
    if (!canvasElement || !canvasElement.height) return;
    fruits = fruits.filter(fruit => {
        fruit.vy += gravity; fruit.x += fruit.vx; fruit.y += fruit.vy;
        return fruit.y < canvasElement.height + fruit.radius * 2; // Keep if above bottom
    });
}
function drawFruits() {
    if (!canvasCtx) return;
    for (const fruit of fruits) {
        canvasCtx.fillStyle = fruit.color;
        canvasCtx.beginPath();
        canvasCtx.arc(fruit.x, fruit.y, fruit.radius, 0, Math.PI * 2);
        canvasCtx.fill();
    }
}
// --- Particle Functions ---
function createSliceEffect(x, y, color) {
    const numParticles = 15 + Math.floor(Math.random() * 10);
    for (let i = 0; i < numParticles; i++) {
        const angle = Math.random() * Math.PI * 2; const speed = 3 + Math.random() * 5;
        particles.push({
            x: x, y: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 1.5,
            radius: Math.random() * 2.5 + 1.5, color: color, life: particleLife + Math.random() * (particleLife / 2)
         });
    }
    /* if (sliceSynth) { sliceSynth.triggerAttackRelease("4n", Tone.now()); } */ // Sound disabled
}
function updateParticles() {
    particles = particles.filter(p => {
        p.vy += particleGravity; p.vx *= particleDrag; p.vy *= particleDrag;
        p.x += p.vx; p.y += p.vy; p.life--;
        return p.life > 0;
    });
}
function drawParticles() {
     if (!canvasCtx) return;
    for (const p of particles) {
        const alpha = Math.max(0, p.life / particleLife).toFixed(2);
        let rgb = '255,255,255';
        const match = p.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
        if (match) { rgb = `${match[1]},${match[2]},${match[3]}`; }
        canvasCtx.fillStyle = `rgba(${rgb}, ${alpha})`;
        canvasCtx.beginPath();
        canvasCtx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        canvasCtx.fill();
    }
}
// --- Slice Fruit Function ---
function sliceFruit(fruit, index) {
    const now = Date.now();
    if (now - lastSliceTime < comboTimeWindow) { comboCounter++; } else { comboCounter = 1; }
    lastSliceTime = now;
    const points = baseScore + (comboCounter > 1 ? (comboCounter -1) * comboBonusMultiplier : 0);
    score += points;
    if(scoreDisplay) scoreDisplay.textContent = `Score: ${score}`; // Update score display
    createSliceEffect(fruit.x, fruit.y, fruit.color);
    fruits.splice(index, 1);
}


// --- Prediction Loop: Continuously Detects Hands & Updates Scene ---
async function predictHands() {
    requestAnimationFrame(predictHands); // Keep looping
    // Ensure essential elements/context are available
    if (!canvasCtx || !detector || !videoElement || videoElement.readyState < 3) { // Use readyState 3
        return;
    }
    if (gameState === 'LOADING') return; // Don't process if still loading

    // 1. Clear Canvas
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // 2. Spawn/Update/Draw Fruits & Particles (Run based on state)
    if (gameState === 'PLAYING') {
        if (Math.random() < fruitSpawnProbability) spawnFruit();
        updateFruits();
        updateParticles();
    }
    drawFruits();
    drawParticles();

    // 3. Hand Detection Logic
    let currentPosition = null;
    let handDetectedThisFrame = false;
    try {
        const hands = await detector.estimateHands(videoElement, { flipHorizontal: false });
        if (hands.length > 0 && hands[0]?.score >= detectionConfidence) {
            handDetectedThisFrame = true;
            const keypoints = hands[0].keypoints;
            if (keypoints) {
                // Draw Full Skeleton
                drawHandLandmarks(keypoints);

                // Find index finger tip for dot/trail/slicing
                const indexFingerTip = keypoints.find(point => point.name === 'index_finger_tip');
                if (indexFingerTip) {
                    const mirroredX = canvasElement.width - indexFingerTip.x; const y = indexFingerTip.y;
                    currentPosition = { x: mirroredX, y: y }; lastKnownPosition = currentPosition;
                } else { currentPosition = lastKnownPosition; }
            } else { currentPosition = lastKnownPosition; }
        } else { currentPosition = lastKnownPosition; }
    } catch (error) { console.error("Error during prediction:", error); }

    // 4. Collision Detection & Slicing (Only if PLAYING)
    if (gameState === 'PLAYING' && currentPosition && isFinite(currentPosition.x) && isFinite(currentPosition.y)) {
         for (let i = fruits.length - 1; i >= 0; i--) {
            const fruit = fruits[i]; const dx = currentPosition.x - fruit.x; const dy = currentPosition.y - fruit.y;
            const distSq = (dx * dx) + (dy * dy); const radiusSq = fruit.radius * fruit.radius;
            if (distSq < radiusSq) {
                sliceFruit(fruit, i); // Call slice logic
            }
        }
     }

    // 5. Update and Draw Hand Trail & Dot
    if (currentPosition) {
         updateTrail(currentPosition); // Re-enable trail
         drawTrail();                 // Re-enable trail
         if (isFinite(currentPosition.x) && isFinite(currentPosition.y)) {
             drawGlowingCircle(currentPosition.x, currentPosition.y); // Draw original dot
         }
    } else {
         trailPoints = []; // Clear trail if no hand position
    }

    // 6. Draw Score handled by DOM elements
}


// --- Drawing Functions ---
// RESTORED Original Glowing Circle
function drawGlowingCircle(x, y) {
    if (!canvasCtx) return;
    canvasCtx.beginPath();
    canvasCtx.arc(x, y, 10, 0, 2 * Math.PI);
    canvasCtx.fillStyle = 'rgba(0, 255, 255, 0.8)';
    canvasCtx.shadowColor = 'cyan';
    canvasCtx.shadowBlur = 20;
    canvasCtx.fill();
    canvasCtx.shadowColor = 'transparent';
    canvasCtx.shadowBlur = 0;
}
// RESTORED Trail drawing functions
function updateTrail(newPosition) {
    trailPoints.push({ ...newPosition, opacity: 0.6 });
    if (trailPoints.length > trailLength) { trailPoints.shift(); }
    for (let i = 0; i < trailPoints.length - 1; i++) { trailPoints[i].opacity *= 0.85; }
    trailPoints = trailPoints.filter(p => p.opacity > 0.05);
}
function drawTrail() {
    if (!canvasCtx) return;
     for (let i = 0; i < trailPoints.length; i++) {
        const point = trailPoints[i]; const radius = 2 + (point.opacity / 0.6) * 4;
        canvasCtx.beginPath(); canvasCtx.arc(point.x, point.y, radius, 0, 2 * Math.PI);
        canvasCtx.fillStyle = `rgba(0, 255, 255, ${point.opacity})`; canvasCtx.fill();
    }
}
// RESTORED Original Skeleton Drawing
function drawHandLandmarks(keypoints) {
     if (!canvasCtx || !keypoints) return;
     canvasCtx.fillStyle = 'rgba(255, 0, 0, 0.7)'; canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.5)'; canvasCtx.lineWidth = 1;
     for (let i = 0; i < keypoints.length; i++) {
         const keypoint = keypoints[i]; if (!keypoint) continue;
         const mirroredX = canvasElement.width - keypoint.x; const y = keypoint.y;
         canvasCtx.beginPath(); canvasCtx.arc(mirroredX, y, 3, 0, 2 * Math.PI); canvasCtx.fill();
     }
     canvasCtx.beginPath();
     HAND_CONNECTIONS.forEach(([i, j]) => {
          if (i >= keypoints.length || j >= keypoints.length) return;
          const kp1 = keypoints[i]; const kp2 = keypoints[j];
          if (kp1 && kp2) {
             const mirroredX1 = canvasElement.width - kp1.x; const mirroredX2 = canvasElement.width - kp2.x;
             canvasCtx.moveTo(mirroredX1, kp1.y); canvasCtx.lineTo(mirroredX2, kp2.y);
          }
     });
     canvasCtx.stroke();
}


// --- Start the Application ---
document.addEventListener('DOMContentLoaded', () => {
    // Make sure canvas context is available before setup
    if (!canvasCtx) {
        updateLoadingMessage("Error: Canvas not supported or context failed.");
        alert("Canvas initialization failed. Please use a modern browser.");
        return;
    }
    setupCameraAndDetector(); // Start setup first
    setupEventListeners(); // Then attach listeners
});

// --- Helper to log video state (can be removed later) ---
function logVideoState() {
    console.log("--- DEBUG: Video Element State Check ---");
    if (!videoElement) { console.log("Video element not found!"); return; }
    console.log("readyState:", videoElement.readyState); console.log("networkState:", videoElement.networkState);
    console.log("paused:", videoElement.paused); console.log("ended:", videoElement.ended);
    console.log("error:", videoElement.error); console.log("srcObject active:", videoElement.srcObject?.active);
    console.log("videoWidth:", videoElement.videoWidth); console.log("videoHeight:", videoElement.videoHeight);
    console.log("--------------------------------------");
}

