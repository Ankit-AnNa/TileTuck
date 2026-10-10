const $=id=>document.getElementById(id);

const PROFILE_KEY="blockQuestProfileV1";
const TOKEN_KEY="blockQuestTokenV1";
const IS_NATIVE_APP=Boolean(window.Capacitor?.isNativePlatform?.());
const PRODUCTION_API_BASE=window.TILETUCK_API_BASE||"https://your-render-backend-url.onrender.com";
const LOCAL_API_BASE=IS_NATIVE_APP?"http://10.0.2.2:8000":"http://localhost:8000";
const DEFAULT_API_BASE=(window.location.hostname==="localhost"||window.location.hostname==="127.0.0.1")?LOCAL_API_BASE:PRODUCTION_API_BASE;
const API_BASE=(localStorage.getItem("blockQuestApi")||DEFAULT_API_BASE).replace(/\/$/,"");
const API_TIMEOUT_MS=10000;
const GAME_STATE_PREFIX="blockQuestGameStateV2:";
const RACE_STATE_PREFIX="blockQuestRaceV2:";

let profile=null;
let isGuest=false;
let authToken=localStorage.getItem(TOKEN_KEY)||"";
let apiAvailable=true;
let restoringState=false;
let passwordResetToken="";
let dashboardData=null;
let dashboardSelectedStage=1;
let dashboardResumeStage=1;
let dashboardResumeLevel=1;
let dashboardActivityTimer=null;
let activeReplay=false;
let replayReturnState=null;

const apiUrl=(path)=>`${API_BASE}${path}`;

async function api(path,options={}){
const headers={"Content-Type":"application/json",...(options.headers||{})};
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),API_TIMEOUT_MS);
let res;
try{
res=await fetch(apiUrl(path),{...options,headers,signal:controller.signal});
}catch(e){
if(e.name==="AbortError") throw new Error("Backend request timed out. Is FastAPI running on port 8000?");
throw new Error("Cannot connect to game server. Start FastAPI on port 8000.");
}finally{
clearTimeout(timer);
}

let data={};
try{ data=await res.json(); }catch(e){}

if(!res.ok){
throw new Error(data.detail||`API error ${res.status}`);
}

return data;
}

function accountKey(){
if(isGuest) return "guest";
return String(profile?.id||profile?.email||"unknown");
}

function gameStateKey(){
return GAME_STATE_PREFIX+accountKey();
}

function raceStateKey(){
return RACE_STATE_PREFIX+accountKey();
}

function saveGameState(){
if(isGuest||!profile?.id||restoringState||activeReplay) return;
try{
localStorage.setItem(gameStateKey(),JSON.stringify({
version:2,
stage,
level,
lives,
score,
tools:{...tools},
board,
pieces,
race,
selectedPiece,
savedAt:Date.now()
}));
scheduleServerProgressSave();
}catch(e){
console.warn("Local game save failed:",e.message);
}
}

function loadGameState(){
if(isGuest||!profile?.id) return false;
try{
const raw=localStorage.getItem(gameStateKey());
if(!raw) return false;
const state=JSON.parse(raw);
if(state.version!==2) return false;
return applySavedState(state);
}catch(e){
console.warn("Saved game restore failed:",e.message);
return false;
}
}

function clearGameState(){
if(!profile?.id) return;
try{
localStorage.removeItem(gameStateKey());
localStorage.removeItem(raceStateKey());
}catch(e){}
}

let progressSaveTimer=null;
let progressSaveInFlight=false;
let progressSaveQueued=false;

function buildProgressPayload(){
return {
token:authToken,
stage,
level,
score,
lives,
hammer:tools.hammer,
break_tool:tools.break,
hint:tools.hint,
board,
pieces,
race
};
}

function scheduleServerProgressSave(){
if(isGuest||!authToken||!profile?.id) return;
clearTimeout(progressSaveTimer);
progressSaveTimer=setTimeout(saveServerProgress,450);
}

async function saveServerProgress(){
if(isGuest||!authToken||!profile?.id||activeReplay) return;
if(progressSaveInFlight){
progressSaveQueued=true;
return;
}
progressSaveInFlight=true;
try{
await api("/api/users/progress",{
method:"PUT",
body:JSON.stringify(buildProgressPayload())
});
}catch(e){
// Phase 3 remains usable if the optional progress endpoint is not added yet.
console.warn("Server progress save skipped:",e.message);
}finally{
progressSaveInFlight=false;
if(progressSaveQueued){
progressSaveQueued=false;
scheduleServerProgressSave();
}
}
}

async function loadServerProgress(){
if(isGuest||!authToken||!profile?.id) return null;
try{
const data=await api(`/api/users/progress?token=${encodeURIComponent(authToken)}`);
return data?.progress||null;
}catch(e){
console.warn("Server progress restore skipped:",e.message);
return null;
}
}

function applySavedState(state){
if(!state) return false;
try{
if(!Number.isInteger(Number(state.stage??1))||Number(state.stage??1)<1) return false;
if(!Number.isInteger(Number(state.level))||Number(state.level)<0||Number(state.level)>=LEVELS.length) return false;
stage=Number(state.stage??1);
const targetLevel=Number(state.level);
const size=LEVELS[targetLevel].size;
if(!Array.isArray(state.board)||state.board.length!==size) return false;
if(!Array.isArray(state.pieces)||!state.pieces.length) return false;
level=targetLevel;
lives=Math.max(0,Number(state.lives??5));
score=Math.max(0,Number(state.score??0));
tools={
hammer:Math.max(0,Number(state.hammer??state.tools?.hammer??1)),
break:Math.max(0,Number(state.break_tool??state.tools?.break??1)),
hint:Math.max(0,Number(state.hint??state.tools?.hint??1))
};
board=state.board;
pieces=state.pieces;
consolidateSavedSingletons();
replenishSuggestions();
if(state.race) race=state.race;
selectedPiece=null;
return true;
}catch(e){
console.warn("Saved state invalid:",e.message);
return false;
}
}

function setAuthError(msg="",success=false){
const error=$("authError");
error.textContent=msg;
error.classList.toggle("auth-success",success);
}

function setAuthMode(mode){
const reg=mode==="register";

passwordResetToken="";
$("passwordResetFields").classList.add("hidden");
$("authTabs").classList.remove("hidden");
$("guestBtn").classList.remove("hidden");
$("guestNote").classList.remove("hidden");
$("authNote").classList.remove("hidden");
$("registerFields").classList.toggle("hidden",!reg);
$("loginFields").classList.toggle("hidden",reg);
$("photoLabel").classList.toggle("hidden",!reg);
$("avatarPreview").classList.toggle("hidden",!reg);
$("registerTab").classList.toggle("active",reg);
$("loginTab").classList.toggle("active",!reg);

setAuthError("");
}

function showPasswordReset(token){
passwordResetToken=token;
$("authScreen").classList.remove("hidden");
$("game").classList.add("hidden");
$("authTabs").classList.add("hidden");
$("registerFields").classList.add("hidden");
$("loginFields").classList.add("hidden");
$("passwordResetFields").classList.remove("hidden");
$("avatarPreview").classList.add("hidden");
$("photoLabel").classList.add("hidden");
$("guestBtn").classList.add("hidden");
$("guestNote").classList.add("hidden");
$("authNote").classList.add("hidden");
setAuthError("");
}

async function requestPasswordReset(){
const emailInput=$("loginEmailInput");
const email=emailInput.value.trim();
if(!email||!emailInput.checkValidity()){
setAuthError("Enter a valid account email first.");
return;
}

setAuthError("Sending reset instructions...");
try{
const data=await api("/api/users/password-reset/request",{
method:"POST",
body:JSON.stringify({email})
});
setAuthError(data.message,true);
}catch(e){
setAuthError(e.message);
}
}

async function resetPassword(){
const password=$("newPasswordInput").value;
const confirmation=$("confirmPasswordInput").value;
if(password.length<6){
setAuthError("Password must be at least 6 characters.");
return;
}
if(password!==confirmation){
setAuthError("Passwords do not match.");
return;
}

setAuthError("Updating password...");
try{
const data=await api("/api/users/password-reset/confirm",{
method:"POST",
body:JSON.stringify({token:passwordResetToken,new_password:password})
});
const query=new URLSearchParams(location.search);
query.delete("reset_token");
history.replaceState(null,"",`${location.pathname}${query.size?`?${query}`:""}${location.hash}`);
setAuthMode("login");
setAuthError(data.message,true);
}catch(e){
setAuthError(e.message);
}
}

function backToLogin(){
const query=new URLSearchParams(location.search);
query.delete("reset_token");
history.replaceState(null,"",`${location.pathname}${query.size?`?${query}`:""}${location.hash}`);
setAuthMode("login");
}

$("registerTab").onclick=()=>setAuthMode("register");
$("loginTab").onclick=()=>setAuthMode("login");
$("forgotPasswordBtn").onclick=requestPasswordReset;
$("resetPasswordBtn").onclick=resetPassword;
$("backToLoginBtn").onclick=backToLogin;

$("serverUrlInput").value=localStorage.getItem("blockQuestApi")||DEFAULT_API_BASE;
$("saveServerUrlBtn").onclick=()=>{
const value=$("serverUrlInput").value.trim().replace(/\/$/,"");
if(!/^https?:\/\//i.test(value)){
setAuthError("Enter a server address starting with http:// or https://");
return;
}
localStorage.setItem("blockQuestApi",value);
location.reload();
};

function startGuest(){
isGuest=true;
authToken="";

profile={
username:"Guest",
email:"",
dob:"",
avatar:null,
best_level:1,
best_score:0
};

stage=1;
level=0;
lives=5;
score=0;
tools={
hammer:1,
break:1,
hint:1
};

race={
startedAt:Date.now(),
completed:0
};

showGame();
}

function logout(){
authToken="";
profile=null;
isGuest=false;

localStorage.removeItem(TOKEN_KEY);
localStorage.removeItem(PROFILE_KEY);

location.reload();
}

function openAuth(){
pauseRaceClock();
isGuest=false;

$("authScreen").classList.remove("hidden");
$("dashboard").classList.add("hidden");
$("game").classList.add("hidden");

setAuthMode("login");
}

async function registerUser(){
const username=$("usernameInput").value.trim();
const email=$("emailInput").value.trim();
const dob=$("dobInput").value;
const password=$("passwordInput").value;

if(!username||!email||!dob||password.length<6){
setAuthError("Fill all fields. Password must be at least 6 characters.");
return;
}

setAuthError("Creating account...");

try{
const data=await api("/api/users/register",{
method:"POST",
body:JSON.stringify({
username,
email,
dob,
password,
avatar:$("photoInput").dataset.data||null
})
});

authToken=data.token;
profile=data.user;

localStorage.setItem(TOKEN_KEY,authToken);
localStorage.setItem(PROFILE_KEY,JSON.stringify(profile));

await showGame();

}catch(e){
setAuthError(e.message);
}
}

async function loginUser(){
const email=$("loginEmailInput").value.trim();
const password=$("loginPasswordInput").value;

if(!email||!password){
setAuthError("Enter email and password.");
return;
}

setAuthError("Logging in...");

try{
const data=await api("/api/users/login",{
method:"POST",
body:JSON.stringify({
email,
password
})
});

authToken=data.token;
profile=data.user;

localStorage.setItem(TOKEN_KEY,authToken);
localStorage.setItem(PROFILE_KEY,JSON.stringify(profile));

await showGame();

}catch(e){
setAuthError(e.message);
}
}

async function loadProfile(){
const resetToken=new URLSearchParams(location.search).get("reset_token");
if(resetToken){
showPasswordReset(resetToken);
return;
}

if(!authToken){
openAuth();
return;
}

setAuthError("");

try{
const me=await api(`/api/users/me?token=${encodeURIComponent(authToken)}`);
profile=me;
isGuest=false;
localStorage.setItem(PROFILE_KEY,JSON.stringify(profile));
showGame();
}catch(e){
console.warn("Session restore failed:",e.message);
authToken="";
profile=null;
localStorage.removeItem(TOKEN_KEY);
localStorage.removeItem(PROFILE_KEY);
openAuth();
}
}

async function showGame(){
$("authScreen").classList.add("hidden");
$("dashboard").classList.add("hidden");
$("game").classList.remove("hidden");

$("miniName").textContent=profile?.username||"Player";
$("profileName").textContent=profile?.username||"Player";
$("profileEmail").textContent=profile?.email||"Guest mode";
$("bestStage").textContent=profile?.best_stage||1;
$("bestLevel").textContent=profile?.best_level||profile?.bestLevel||1;
$("bestScore").textContent=profile?.best_score||profile?.bestScore||0;
$("guestAccountBtn").classList.toggle("hidden",!isGuest);
$("logoutBtn").textContent=isGuest?"Exit Guest":"Logout";

if(!isGuest){
loadRace();
}else{
race={startedAt:Date.now(),completed:0};
}

if(profile?.avatar){
$("miniAvatar").innerHTML=`<img src="${profile.avatar}" alt="Avatar">`;
$("avatarPreview").innerHTML=`<img src="${profile.avatar}" alt="Avatar">`;
}

restoringState=true;
let restored=false;

if(!isGuest){
const serverState=await loadServerProgress();
restored=applySavedState(serverState);
}

if(!restored){
restored=loadGameState();
}

restoringState=false;

if(restored){
renderAll();
updateStats();
toast(`Level ${level+1} restored`);
if(board.length&&board.flat().every(cell=>cell!==null)){
winLevel(false);
toast(`Stage ${stage} · Level ${level+1} is complete. Continue to advance.`);
}
}else if(!pieces||pieces.length===0){
stage=Math.max(1,Number(profile?.best_stage||1));
level=Math.max(0,Math.min(LEVELS.length-1,(profile?.best_level||1)-1));
startLevel();
}

renderLeaderboard();
updateRaceUI();
await showDashboard();
}

function localDashboardData(){
const completed=Number(race?.completed)||0;
const completedLevels={};
for(let stageNumber=1;stageNumber<=stage;stageNumber++){
const count=stageNumber<stage?10:Math.min(10,Math.max(0,completed-(stageNumber-1)*10));
completedLevels[String(stageNumber)]=Array.from({length:count},(_,index)=>index+1);
}
const boardComplete=board.length>0&&board.flat().every(cell=>cell!==null);
if(boardComplete){
completedLevels[String(stage)]||=[];
if(!completedLevels[String(stage)].includes(level+1))completedLevels[String(stage)].push(level+1);
}
const resumeStage=boardComplete&&level===9?stage+1:stage;
const resumeLevel=boardComplete?(level===9?1:level+2):level+1;
return {
username:profile?.username||"Guest",
current_stage:stage,
current_level:level+1,
resume_stage:resumeStage,
resume_level:resumeLevel,
current_complete:boardComplete,
stage_count:Math.max(stage+1,resumeStage),
completed_levels:completedLevels,
best_stage:profile?.best_stage||stage,
best_level:profile?.best_level||level+1,
best_score:profile?.best_score||score,
players:[]
};
}

async function sendDashboardActivity(activityStage=stage,activityLevel=level+1){
if(isGuest||!authToken||activeReplay)return;
try{
await api("/api/activity",{
method:"POST",
body:JSON.stringify({token:authToken,stage:activityStage,level:activityLevel})
});
}catch(e){
console.warn("Stage activity sync skipped:",e.message);
}
}

async function loadDashboardData(stageNumber){
if(isGuest||!authToken||!profile?.id){
dashboardData=localDashboardData();
return dashboardData;
}
try{
dashboardData=await api(`/api/dashboard?token=${encodeURIComponent(authToken)}&stage=${stageNumber}`);
}catch(e){
console.warn("Dashboard sync skipped:",e.message);
dashboardData=localDashboardData();
}
return dashboardData;
}

function renderStageRail(){
const rail=$("stageRail");
const count=Math.max(1,Number(dashboardData?.stage_count)||1);
const completedLevels=dashboardData?.completed_levels||{};
rail.innerHTML="";

for(let stageNumber=1;stageNumber<=count;stageNumber++){
const unlocked=stageNumber<=dashboardResumeStage;
const cleared=(completedLevels[String(stageNumber)]||[]).length>=10;
const done=(completedLevels[String(stageNumber)]||[]).length;
const button=document.createElement("button");
button.type="button";
button.className="stage-node"+(stageNumber===dashboardSelectedStage?" selected":"")+(cleared?" completed":"")+(!unlocked?" locked":"");
button.disabled=!unlocked;
button.setAttribute("role","tab");
button.setAttribute("aria-selected",String(stageNumber===dashboardSelectedStage));
button.innerHTML=`<span class="stage-node-title">Stage ${stageNumber}</span><span class="stage-node-mark">${cleared?"✓":unlocked?"✦":"🔒"}</span><span class="stage-node-meta">${cleared?"Stage cleared":`${done} / 10 levels cleared`}</span><span class="stage-node-bar"><i style="width:${done*10}%"></i></span>`;
button.onclick=()=>showDashboard(stageNumber);
rail.appendChild(button);
}
}

function renderLevelGrid(){
const grid=$("levelGrid");
const completed=new Set((dashboardData?.completed_levels||{})[String(dashboardSelectedStage)]||[]);
grid.innerHTML="";
let clearedCount=0;

for(let levelNumber=1;levelNumber<=10;levelNumber++){
const isCleared=completed.has(levelNumber);
const isCurrent=dashboardSelectedStage===dashboardResumeStage&&levelNumber===dashboardResumeLevel;
const playable=isCleared||isCurrent;
if(isCleared)clearedCount++;

const button=document.createElement("button");
button.type="button";
button.className="level-node"+(isCleared?" completed":"")+(isCurrent?" current":"");
button.disabled=!playable;
button.setAttribute("aria-label",`Stage ${dashboardSelectedStage}, Level ${levelNumber}, ${isCleared?"completed":isCurrent?"continue":"locked"}`);
button.innerHTML=`<span class="level-node-number">${String(levelNumber).padStart(2,"0")}</span><span class="level-node-state">${isCleared?"✓":isCurrent?"▶":"🔒"}</span><span class="level-node-label">${isCleared?"Cleared":isCurrent?"Continue":"Not yet"}</span>`;
button.onclick=()=>startDashboardLevel(dashboardSelectedStage,levelNumber);
grid.appendChild(button);
}

const canResume=dashboardSelectedStage===dashboardResumeStage;
$("resumeLevelBtn").disabled=!canResume;
$("resumeLevelBtn").textContent=canResume?`CONTINUE · LEVEL ${dashboardResumeLevel} →`:"CHOOSE AN OPEN TRAIL";
$("selectedStageEyebrow").textContent=`STAGE ${dashboardSelectedStage}`;
$("selectedStageTitle").textContent=clearedCount===10?"Every trail, beautifully cleared":"Ten little puzzles";
$("levelMapNote").textContent=canResume
?`Level ${dashboardResumeLevel} is your next stop. The owl insists you are doing great.`
:clearedCount===10?"All ten trails cleared. Revisit any puzzle for a victory lap.":"Every glowing level is yours to replay. Locked trails open in order.";
$("dashboardProgressLabel").textContent=canResume?`Stage ${dashboardResumeStage} · Level ${dashboardResumeLevel}`:`Stage ${dashboardSelectedStage} · ${clearedCount} / 10 cleared`;
$("dashboardProgressCount").textContent=`${clearedCount} / 10 cleared`;
$("dashboardProgressFill").style.width=`${clearedCount*10}%`;
}

function renderStagePlayers(){
const list=$("stagePlayers");
const players=dashboardData?.players||[];
$("playersCaption").textContent=`Players exploring Stage ${dashboardSelectedStage}`;
list.innerHTML="";

if(!players.length){
list.innerHTML=`<div class="players-empty">No trail buddies here just yet.<br>Be the first firefly in the woods.</div>`;
return;
}

for(const player of players){
const row=document.createElement("div");
row.className="trail-player"+(player.username===profile?.username?" you":"");
const firefly=player.playing?"✦":player.status==="Stage cleared"?"✓":"•";
row.innerHTML=`<span class="player-firefly" aria-hidden="true">${firefly}</span><span class="trail-player-name"></span><span class="trail-player-status"></span>`;
row.querySelector(".trail-player-name").textContent=player.username;
row.querySelector(".trail-player-status").textContent=player.status==="Playing now"?`Playing · L${player.level}`:player.status;
list.appendChild(row);
}
}

async function showDashboard(stageNumber=null){
if(activeReplay&&replayReturnState)restoreReplayState();
pauseRaceClock();
$("authScreen").classList.add("hidden");
$("game").classList.add("hidden");
$("dashboard").classList.remove("hidden");
const boardComplete=board.length>0&&board.flat().every(cell=>cell!==null);
const activityStage=boardComplete&&level===LEVELS.length-1?stage+1:stage;
const activityLevel=boardComplete?(level===LEVELS.length-1?1:level+2):level+1;
await sendDashboardActivity(activityStage,activityLevel);
await loadDashboardData(stageNumber||stage);
dashboardResumeStage=dashboardData.resume_stage||dashboardResumeStage;
dashboardResumeLevel=dashboardData.resume_level||dashboardResumeLevel;
dashboardSelectedStage=Math.min(Math.max(1,Number(stageNumber)||dashboardResumeStage),dashboardResumeStage);
if(dashboardSelectedStage!==dashboardData.selected_stage){
await loadDashboardData(dashboardSelectedStage);
}
$("dashboardUsername").textContent=dashboardData.username||profile?.username||"Guest";
$("dashboardAvatar").innerHTML=profile?.avatar?`<img src="${profile.avatar}" alt="">`:"🌙";
$("dashboardBestStage").textContent=dashboardData.best_stage||1;
$("dashboardBestLevel").textContent=dashboardData.best_level||1;
$("dashboardBestScore").textContent=Number(dashboardData.best_score||0).toLocaleString();
$("dashboardQuip").textContent=dashboardData.current_complete
?"You cleared the trail. The owl has stopped pretending to be surprised."
:"The owls have checked your homework. Mostly.";
$("dashboardSaveNote").textContent=isGuest?"Guest progress is just for this visit.":"Progress saved to your account.";
renderStageRail();
renderLevelGrid();
renderStagePlayers();

if(!isGuest&&!dashboardActivityTimer){
dashboardActivityTimer=setInterval(()=>{
const playing=!$("game").classList.contains("hidden");
sendDashboardActivity(playing?stage:dashboardResumeStage,playing?level+1:dashboardResumeLevel);
},60000);
}
}

function snapshotReplayState(){
return {stage,level,lives,score,tools:{...tools},board:board.map(row=>row.slice()),pieces:pieces.map(piece=>({...piece,shape:cloneShape(piece.shape)})),race:race?{...race}:race};
}

function restoreReplayState(){
if(!replayReturnState)return;
({stage,level,lives,score,tools,board,pieces,race}=replayReturnState);
replayReturnState=null;
activeReplay=false;
selectedPiece=null;
renderAll();
updateStats();
}

function startDashboardLevel(stageNumber,levelNumber){
if(stageNumber===dashboardResumeStage&&levelNumber===dashboardResumeLevel){
activeReplay=false;
replayReturnState=null;
if(stage!==stageNumber||level!==levelNumber-1){
stage=stageNumber;
level=levelNumber-1;
startLevel();
}
}else{
replayReturnState=snapshotReplayState();
activeReplay=true;
stage=stageNumber;
level=levelNumber-1;
startLevel();
}

$("dashboard").classList.add("hidden");
$("game").classList.remove("hidden");
updateStats();
startRaceClock();
void sendDashboardActivity();
if(board.flat().every(cell=>cell!==null))winLevel(false);
window.scrollTo({top:0,behavior:"smooth"});
}

$("photoInput").addEventListener("change",e=>{
const file=e.target.files[0];

if(!file)return;

const reader=new FileReader();

reader.onload=()=>{
$("avatarPreview").innerHTML=
`<img src="${reader.result}">`;

$("photoInput").dataset.data=
  reader.result;

};

reader.readAsDataURL(file);
});

$("guestBtn").onclick=startGuest;
$("startGameBtn").onclick=registerUser;
$("loginBtn").onclick=loginUser;
$("guestAccountBtn").onclick=openAuth;
$("logoutBtn").onclick=logout;
$("dashboardLogoutBtn").onclick=logout;
$("backToDashboard").onclick=()=>showDashboard();
$("resumeLevelBtn").onclick=()=>startDashboardLevel(dashboardResumeStage,dashboardResumeLevel);
$("refreshStagePlayers").onclick=()=>showDashboard(dashboardSelectedStage);

$("profileToggle").onclick=()=>{
$("profilePanel").classList.toggle("hidden");
};

const LEVELS=[
{size:3},
{size:4},
{size:4},
{size:5},
{size:5},
{size:6},
{size:6},
{size:7},
{size:7},
{size:8}
];

let stage=1;
let level=0;
let lives=5;
let score=0;

let board=[];
let pieces=[];

let drag=null;
let selectedPiece=null;

let tools={
hammer:1,
break:1,
hint:1
};

const boardEl=$("board");
const piecesEl=$("pieces");

function toast(t){
$("toast").textContent=t;
$("toast").classList.remove("hidden");

clearTimeout(toast.t);

toast.t=setTimeout(()=>{
$("toast").classList.add("hidden");
},1700);
}

let tutorialPending=false;

function openTutorial(){
tutorialPending=true;
$("tutorialOverlay").classList.remove("hidden");
}

function closeTutorial(){
$("tutorialOverlay").classList.add("hidden");
tutorialPending=false;

try{
localStorage.setItem(
"blockQuestSeenTutorial",
"1"
);
}catch(e){}
}

async function startTutorialGame(){
// Never overwrite an already-saved account game just because the tutorial
// is being shown again on a new browser/device.
if(!isGuest && profile?.id){
try{
const saved=await loadServerProgress();
if(saved?.board && saved?.pieces){
if(applySavedState(saved)){
closeTutorial();
renderAll();
updateStats();
startRaceClock();
toast(`Level ${level+1} restored.`);
return;
}
}
}catch(e){
console.warn("Tutorial restore check failed:",e.message);
}
}

closeTutorial();
selectedPiece=null;
stage=1;
level=0;
lives=isGuest?5:(profile?.lives||5);
score=0;
tools=isGuest
?{hammer:1,break:1,hint:1}
:{
hammer:profile?.hammer??1,
break:profile?.break_tool??1,
hint:profile?.hint??1
};

startLevel();
startRaceClock(true);
saveGameState();
toast("🎯 Level 1: Fill all 9 squares!");
}

$("startTutorialGame").onclick=startTutorialGame;

$("tutorialClose").onclick=closeTutorial;

$("replayTutorial").onclick=()=>{
$("tutorialOverlay").classList.remove("hidden");
};

function cloneShape(s){
return s.map(p=>[p[0],p[1]]);
}

function normalize(shape){
const minR=Math.min(...shape.map(p=>p[0]));
const minC=Math.min(...shape.map(p=>p[1]));

return shape
.map(([r,c])=>[
r-minR,
c-minC
])
.sort(
(a,b)=>
a[0]-b[0]||
a[1]-b[1]
);
}

function rotate(shape){
return normalize(
shape.map(([r,c])=>[
c,
-r
])
);
}

function key(shape){
return normalize(shape)
.map(p=>p.join(","))
.join(";");
}

function randomInt(n){
return Math.floor(
Math.random()*n
);
}

function makeGuaranteedPuzzle(size){
const path=[];
const firstDirection=randomInt(2);
for(let r=0;r<size;r++){
const reverse=(r+firstDirection)%2===1;
for(let step=0;step<size;step++){
const c=reverse?size-1-step:step;
path.push([r,c]);
}
}

const result=[];
let offset=0;
while(offset<path.length){
const remaining=path.length-offset;
let target=remaining<=5?remaining:2+randomInt(4);
if(remaining-target===1)target=target===2?3:target-1;
result.push(normalize(path.slice(offset,offset+target)));
offset+=target;
}

return result.sort(()=>Math.random()-.5);
}

function splitPieceShape(shape){
let best=null;
const limit=1<<shape.length;

for(let mask=1;mask<limit-1;mask++){
const left=shape.filter((_,index)=>mask&(1<<index));
const right=shape.filter((_,index)=>!(mask&(1<<index)));
if(left.length<2||right.length<2)continue;
if(!isConnectedShape(left)||!isConnectedShape(right))continue;
const balance=Math.abs(left.length-right.length);
if(!best||balance<best.balance)best={left,right,balance};
}

if(best)return [normalize(best.left),normalize(best.right)];
return null;
}

function isConnectedShape(shape){
if(!shape.length)return false;
const visited=new Set([shape[0].join(",")]);
const pending=[shape[0]];
while(pending.length){
const [row,col]=pending.pop();
for(const [nextRow,nextCol] of shape){
if(Math.abs(row-nextRow)+Math.abs(col-nextCol)!==1)continue;
const key=`${nextRow},${nextCol}`;
if(!visited.has(key)){
visited.add(key);
pending.push([nextRow,nextCol]);
}
}
}
return visited.size===shape.length;
}

function appendConnectedCell(shape){
const occupied=new Set(shape.map(cell=>cell.join(",")));
for(const [row,col] of shape){
for(const [nextRow,nextCol] of [[row-1,col],[row,col-1],[row,col+1],[row+1,col]]){
if(!occupied.has(`${nextRow},${nextCol}`))return normalize([...shape,[nextRow,nextCol]]);
}
}
return shape;
}

function consolidateSavedSingletons(){
const singles=pieces.filter(piece=>!piece.placed&&piece.shape.length===1);
if(!singles.length)return;

const multiPieces=pieces
.filter(piece=>!piece.placed&&piece.shape.length>1)
.sort((a,b)=>a.shape.length-b.shape.length);

for(const single of singles){
const target=multiPieces.find(piece=>piece.shape.length<5);
if(target){
target.shape=appendConnectedCell(target.shape);
pieces=pieces.filter(piece=>piece!==single);
multiPieces.sort((a,b)=>a.shape.length-b.shape.length);
}
}

const remainingSingles=pieces.filter(piece=>!piece.placed&&piece.shape.length===1);
if(remainingSingles.length>1){
const newShapes=makeConnectedPieces(remainingSingles.length,board.length);
const nextId=pieces.reduce((max,piece)=>Math.max(max,Number(piece.id)||0),-1)+1;
pieces=pieces.filter(piece=>!remainingSingles.includes(piece));
newShapes.forEach((shape,index)=>pieces.push({id:nextId+index,shape,placed:false}));
}
}

function makeConnectedPieces(totalCells,width){
if(totalCells<=1)return [Array.from({length:totalCells},()=>[0,0])];
const path=[];
let remaining=totalCells;
let row=0;
while(remaining){
const rowCells=Math.min(width,remaining);
for(let step=0;step<rowCells;step++){
path.push([row,width>1&&row%2===1?width-1-step:step]);
}
remaining-=rowCells;
row++;
}

const shapes=[];
let offset=0;
while(offset<path.length){
const left=path.length-offset;
let size=left<=5?left:2+randomInt(4);
if(left-size===1)size=size===2?3:size-1;
shapes.push(normalize(path.slice(offset,offset+size)));
offset+=size;
}
return shapes;
}

function startLevel(){

pauseRaceClock();
levelElapsedMs=0;

const size=
LEVELS[level].size;

board=
Array.from(
{length:size},
()=>Array(size).fill(null)
);

let shapes;

if(level===0){

shapes=[
  [
    [0,0],
    [0,1],
    [1,0],
    [1,1]
  ],
  [
    [0,2],
    [1,2],
    [2,0],
    [2,1],
    [2,2]
  ]
];

}else{

shapes=
  makeGuaranteedPuzzle(size);

}

pieces=
shapes.map(
(shape,i)=>({
id:i,
shape,
placed:false
})
);

replenishSuggestions();
renderAll();
updateStats();
saveGameState();
}

function replenishSuggestions(){
let available=pieces.filter(p=>!p.placed).length;
let nextId=pieces.reduce((max,p)=>Math.max(max,Number(p.id)||0),-1)+1;

while(available<3){
const candidates=pieces
.filter(piece=>!piece.placed&&piece.shape.length>=4)
.sort((a,b)=>b.shape.length-a.shape.length);
const expandable=candidates.find(piece=>splitPieceShape(piece.shape));
if(!expandable)return;

const split=splitPieceShape(expandable.shape);
expandable.shape=split[0];
pieces.push({id:nextId++,shape:split[1],placed:false});
available++;
}
}

function renderAll(){
renderBoard();
renderPieces();
updateProgress();
}

/* ========================================================
BOARD RENDER - FINAL FIX
IMPORTANT:

Cell NEVER gets "filled"

Cell NEVER gets "piece-color-*"

Only .wood-block is the actual visible block
======================================================== */

function renderBoard(){

const size = LEVELS[level].size;

// Clear old board completely
boardEl.innerHTML = "";

// Board grid
boardEl.style.display = "grid";
boardEl.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
boardEl.style.gridTemplateRows = `repeat(${size}, 1fr)`;

for(let r = 0; r < size; r++){

for(let c = 0; c < size; c++){

  const cell = document.createElement("div");

  const pid = board[r][c];

  // IMPORTANT:
  // Never add "filled" or piece-color class to cell
  cell.className = "cell";

  cell.dataset.r = r;
  cell.dataset.c = c;

  /*
   * Keep cell only as a container.
   * Actual puzzle block will be inside it.
   */
  cell.style.position = "relative";
  cell.style.overflow = "hidden";
  cell.style.boxSizing = "border-box";

  if(pid !== null){

    const ci =
      pid % PIECE_PALETTE.length;

    const palette =
      PIECE_PALETTE[ci];

    /*
     * ACTUAL PLACED BLOCK
     */
    const woodBlock =
      document.createElement("div");

    woodBlock.className =
      `wood-block piece-color-${ci}`;

    /*
     * FORCE VISIBILITY
     *
     * This is the important part.
     */
    woodBlock.style.cssText = `
      width: 100% !important;
      height: 100% !important;
      min-width: 0 !important;
      min-height: 0 !important;

      margin: 0 !important;
      padding: 0 !important;

      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;

      position: absolute !important;
      left: 0 !important;
      top: 0 !important;

      box-sizing: border-box !important;

      z-index: 20 !important;

      pointer-events: none !important;

      background:
        linear-gradient(
          145deg,
          ${palette.light},
          ${palette.mid} 55%,
          ${palette.dark}
        ) !important;

      border: 2px solid ${palette.dark} !important;

      border-radius: 5px !important;

      box-shadow:
        inset 0 1px 0 rgba(255,255,255,.35),
        inset 0 -2px 0 rgba(0,0,0,.25),
        0 1px 2px rgba(0,0,0,.35) !important;
    `;

    /*
     * Extra attributes for debugging / styling
     */
    woodBlock.dataset.boardPiece = "true";
    woodBlock.dataset.pieceId = pid;
    woodBlock.dataset.row = r;
    woodBlock.dataset.col = c;

    /*
     * Make sure the block is actually inside
     * the correct board cell.
     */
    cell.appendChild(woodBlock);
  }

  boardEl.appendChild(cell);
}

}
}

function clearPlacementTargets(){
boardEl.querySelectorAll(".placement-option").forEach(cell=>cell.classList.remove("placement-option"));
}

function highlightLegalTargets(piece){
clearPlacementTargets();
const size=LEVELS[level].size;
for(let row=0;row<size;row++){
for(let col=0;col<size;col++){
if(!canPlace(piece.shape,row,col))continue;
boardEl.children[row*size+col]?.classList.add("placement-option");
}
}
}

function selectPieceForPlacement(piece,message="👆 Tap a glowing square to place this piece",refresh=false){
if(selectedPiece===piece.id){
if(!refresh)return;
renderPieces();
highlightLegalTargets(piece);
if(message)toast(message);
return;
}
selectedPiece=piece.id;
renderPieces();
highlightLegalTargets(piece);
if(message)toast(message);
}

function handleBoardTap(e){

if(selectedPiece===null){
return;
}

const cell=
e.target.closest(".cell");

if(!cell){
return;
}

const p=
pieces.find(
x=>
x.id===selectedPiece &&
!x.placed
);

if(!p)return;

const row=Number(cell.dataset.r);
const col=Number(cell.dataset.c);
if(!canPlace(p.shape,row,col)){
placePiece(p,row,col);
return;
}

selectedPiece=null;
clearPlacementTargets();
placePiece(p,row,col);
}

boardEl.addEventListener(
"click",
handleBoardTap
);

boardEl.addEventListener(
"mousemove",
e=>{

if(selectedPiece===null){
  return;
}

const p=
  pieces.find(
    x=>
      x.id===selectedPiece &&
      !x.placed
  );

if(!p){
  return;
}

previewAt(
  e.clientX,
  e.clientY,
  p.shape,
  p.id
);

}
);

boardEl.addEventListener(
"mouseleave",
clearPreview
);

function renderPieces(){

piecesEl.innerHTML="";

const available=
pieces.filter(
p=>!p.placed
).slice(0,3);

if(!available.length){

piecesEl.innerHTML=
  '<div class="pieces-empty">🎉 All pieces placed!</div>';

return;

}

available.forEach(p=>{

const card=
  document.createElement("div");

card.className=
  "piece-card"+
  (
    selectedPiece===p.id
      ?" selected-card"
      :""
  );

card.dataset.id=p.id;


const shapeBox=
  document.createElement("div");

shapeBox.className="piece";

shapeBox.dataset.id=p.id;

drawPiece(
  shapeBox,
  p.shape,
  p.id
);

addDrag(
  shapeBox,
  p
);


const actions=
  document.createElement("div");

actions.className=
  "piece-actions";


const rotateBtn=
  document.createElement("button");

rotateBtn.className=
  "piece-action";

rotateBtn.textContent=
  "↻ Rotate";

rotateBtn.onclick=e=>{

  e.stopPropagation();

  p.shape=
    rotate(p.shape);

  selectPieceForPlacement(p,"↻ Rotated. Tap a glowing square to place",true);
};


const selectBtn=
  document.createElement("button");

selectBtn.className=
  "piece-action primary-piece";

selectBtn.textContent=
  selectedPiece===p.id
    ?"✓ Selected"
    :"Select";

selectBtn.onclick=e=>{

  e.stopPropagation();

  selectPieceForPlacement(p);
};


actions.appendChild(
  rotateBtn
);

actions.appendChild(
  selectBtn
);


card.appendChild(
  shapeBox
);

card.appendChild(
  actions
);


card.onclick=()=>{
  selectPieceForPlacement(p);
};


piecesEl.appendChild(
  card
);

});
}

const PIECE_PALETTE=[
{
name:"oak",
light:"#e8c090",
mid:"#c9956a",
dark:"#7a5230"
},
{
name:"cherry",
light:"#d89068",
mid:"#b86a42",
dark:"#7a3f22"
},
{
name:"walnut",
light:"#b88860",
mid:"#966840",
dark:"#5c3820"
},
{
name:"maple",
light:"#f0d098",
mid:"#d4aa68",
dark:"#9a7040"
},
{
name:"teak",
light:"#c8a070",
mid:"#a07848",
dark:"#684828"
},
{
name:"mahogany",
light:"#c07050",
mid:"#984838",
dark:"#602820"
}
];

function drawPiece(
el,
shape,
pieceId
){

const ci=
pieceId%PIECE_PALETTE.length;

const maxR=
Math.max(
...shape.map(
p=>p[0]
)
);

const maxC=
Math.max(
...shape.map(
p=>p[1]
)
);

const cellSize=window.matchMedia("(max-width: 480px)").matches?12:26;

el.style.gridTemplateRows=
`repeat(${maxR+1},${cellSize}px)`;

el.style.gridTemplateColumns=
`repeat(${maxC+1},${cellSize}px)`;

el.style.gap="2px";

el.dataset.pieceColor=ci;

shape.forEach(
([r,c])=>{

  const x=
    document.createElement("div");

  x.className=
    `wood-block piece-color-${ci}`;

  x.style.gridRow=
    r+1;

  x.style.gridColumn=
    c+1;

  el.appendChild(x);
}

);
}

function addDrag(el,p){

let moved=false;
let lastTap=0;

el.addEventListener("touchend",()=>{
if(p.placed)return;
if(drag?.p===p&&moved)return;
selectPieceForPlacement(p);
},{passive:true});

el.addEventListener(
"dblclick",
e=>{

  e.preventDefault();

  p.shape=
    rotate(p.shape);

  renderPieces();

  toast(
    "↻ Piece rotated"
  );
}

);

el.addEventListener(
"pointerdown",
e=>{

  el.setPointerCapture?.(
    e.pointerId
  );

  const now=Date.now();


  if(now-lastTap<350){

    p.shape=
      rotate(p.shape);

    renderPieces();

    toast(
      "↻ Piece rotated"
    );

    lastTap=0;

    return;
  }


  lastTap=now;

  moved=false;


  drag={
    p,
    startX:e.clientX,
    startY:e.clientY,
    x:e.clientX,
    y:e.clientY,
    ghost:null
  };

  el.classList.add(
    "selected"
  );
}

);

el.addEventListener(
"pointermove",
e=>{

  if(
    !drag||
    drag.p!==p
  ){
    return;
  }


  if(
    Math.hypot(
      e.clientX-drag.startX,
      e.clientY-drag.startY
    )>5
  ){
    moved=true;
  }


  drag.x=e.clientX;
  drag.y=e.clientY;


  if(moved){

    if(!drag.ghost){

      drag.ghost=
        createGhost(
          p.shape,
          p.id
        );
    }


    drag.ghost.style.left=
      e.clientX+"px";

    drag.ghost.style.top=
      e.clientY+"px";


    previewAt(
      e.clientX,
      e.clientY,
      p.shape,
      p.id
    );
  }
}

);

el.addEventListener(
"pointerup",
e=>{

  if(
    !drag||
    drag.p!==p
  ){
    return;
  }


  clearPreview();


  if(moved){

    const pos=
      pointToCell(
        e.clientX,
        e.clientY
      );


    if(pos){

      placePiece(
        p,
        pos.r,
        pos.c
      );

    }else{

      toast(
        "Drop the piece on the board."
      );
    }
  }else{
    selectPieceForPlacement(p);
  }


  if(drag.ghost){
    drag.ghost.remove();
  }

  drag=null;

  el.classList.remove(
    "selected"
  );
}

);
}

function createGhost(
shape,
pieceId
){

const g=
document.createElement("div");

g.className=
"drag-ghost";

const ci=
pieceId%PIECE_PALETTE.length;

const maxR=
Math.max(
...shape.map(
p=>p[0]
)
);

const maxC=
Math.max(
...shape.map(
p=>p[1]
)
);

g.style.gridTemplateRows=
`repeat(${maxR+1},26px)`;

g.style.gridTemplateColumns=
`repeat(${maxC+1},26px)`;

g.style.gap="2px";

shape.forEach(
([r,c])=>{

  const x=
    document.createElement("div");

  x.className=
    `wood-block piece-color-${ci}`;

  x.style.gridRow=
    r+1;

  x.style.gridColumn=
    c+1;

  g.appendChild(x);
}

);

document.body.appendChild(g);

return g;
}

function pointToCell(x,y){

const rect=
boardEl.getBoundingClientRect();

if(
x<rect.left||
x>rect.right||
y<rect.top||
y>rect.bottom
){
return null;
}

const size=
LEVELS[level].size;

const cs=
rect.width/size;

return {
r:Math.floor(
(y-rect.top)/cs
),
c:Math.floor(
(x-rect.left)/cs
)
};
}

function canPlace(
shape,
r,
c
){

const size=
LEVELS[level].size;

return shape.every(
([dr,dc])=>{

  const rr=r+dr;
  const cc=c+dc;


  return(
    rr>=0&&
    cc>=0&&
    rr<size&&
    cc<size&&
    board[rr][cc]===null
  );
}

);
}

function previewAt(
x,
y,
shape,
pieceId
){

clearPreview();

const pos=
pointToCell(x,y);

if(!pos){
return;
}

const ok=
canPlace(
shape,
pos.r,
pos.c
);

shape.forEach(
([dr,dc])=>{

  const rr=
    pos.r+dr;

  const cc=
    pos.c+dc;


  if(
    rr>=0&&
    cc>=0&&
    rr<board.length&&
    cc<board.length
  ){

    const cell=
      boardEl.children[
        rr*board.length+cc
      ];


    if(cell){

      cell.classList.add(
        ok
          ?"preview"
          :"bad"
      );
    }
  }
}

);
}

function clearPreview(){

boardEl
.querySelectorAll(
".preview,.bad"
)
.forEach(
cell=>{

    cell.classList.remove(
      "preview",
      "bad"
    );


    /*
      Safety cleanup.

      Old renderer may have added
      piece-color-* directly to cells.

      Remove them permanently.
    */

    PIECE_PALETTE.forEach(
      (_,i)=>{
        cell.classList.remove(
          `piece-color-${i}`
        );
      }
    );
  }
);

}

/* ========================================================
FINAL PLACEMENT FUNCTION
======================================================== */

function placePiece(
p,
r,
c
){

if(
!canPlace(
p.shape,
r,
c
)
){

selectPieceForPlacement(p,"Doesn't fit there. The glowing squares are valid spots.",true);

return;

}

/*
Write the piece ONLY into board state.
*/

p.shape.forEach(
([dr,dc])=>{
board[r+dr][c+dc]=p.id;
}
);

/*
Mark exact source piece as consumed.
*/

p.placed=true;
replenishSuggestions();

selectedPiece=null;
clearPlacementTargets();

score+=
p.shape.length*15;

saveGameState();

/*
Remove all temporary visuals.
*/

clearPreview();

document
.querySelectorAll(
".drag-ghost"
)
.forEach(
g=>g.remove()
);

/*
Rebuild everything from board[][].

This means:
board[][] = source of truth
.wood-block = ONLY visual block

*/

renderAll();

if(
board
.flat()
.every(v=>v!==null)
){

winLevel();

return;

}

if(
!hasAnyLegalMove()
){

failLevel();

}
}

function orientations(shape){

const out=[];
const seen=new Set();

let s=
cloneShape(shape);

for(let i=0;i<4;i++){

const n=
  normalize(s);

const k=
  key(n);


if(!seen.has(k)){

  seen.add(k);
  out.push(n);
}


s=
  rotate(s);

}

return out;
}

function findAnyMove(){

const size=
LEVELS[level].size;

for(
const p
of pieces.filter(
x=>!x.placed
)
){

for(
  const shape
  of orientations(p.shape)
){

  for(
    let r=0;
    r<size;
    r++
  ){

    for(
      let c=0;
      c<size;
      c++
    ){

      if(
        canPlace(
          shape,
          r,
          c
        )
      ){

        return{
          p,
          shape,
          r,
          c
        };
      }
    }
  }
}

}

return null;
}

function hasAnyLegalMove(){
return !!findAnyMove();
}

function showHint(){

if(!tools.hint){

toast(
  "No Hint left."
);

return;

}

const move=
findAnyMove();

tools.hint--;
updateStats();
saveGameState();

if(!move){

toast(
  "No legal move found."
);

return;

}

move.shape.forEach(
([dr,dc])=>{

  const rr=
    move.r+dr;

  const cc=
    move.c+dc;


  const cell=
    boardEl.children[
      rr*board.length+cc
    ];


  if(cell){
    cell.classList.add(
      "hint"
    );
  }
}

);

toast(
"💡 Hint: place the highlighted piece here."
);

setTimeout(
()=>{
boardEl
.querySelectorAll(".hint")
.forEach(
x=>
x.classList.remove("hint")
);
},
2200
);
}

/* ========================================================
HAMMER FIX
Does NOT depend on .cell.filled anymore.
======================================================== */

function hammer(){

if(!tools.hammer){

toast(
  "No Hammer left."
);

return;

}

const occupied=[];

for(
let r=0;
r<board.length;
r++
){

for(
  let c=0;
  c<board.length;
  c++
){

  if(
    board[r][c]!==null
  ){

    occupied.push([
      r,
      c
    ]);
  }
}

}

if(!occupied.length){

toast(
  "There is no block to remove."
);

return;

}

const[
r,
c
]=
occupied[
occupied.length-1
];

board[r][c]=null;

tools.hammer--;

score=
Math.max(
0,
score-5
);

renderAll();

toast(
"🔨 One block removed."
);
}

function breakTool(){

if(!tools.break){

toast(
  "No Break tool left."
);

return;

}

const coords=[];

for(
let r=0;
r<board.length;
r++
){

for(
  let c=0;
  c<board.length;
  c++
){

  if(
    board[r][c]!==null
  ){

    coords.push([
      r,
      c
    ]);
  }
}

}

if(!coords.length){

toast(
  "There are no blocks to break."
);

return;

}

const count=
Math.max(
1,
Math.ceil(
coords.length/3
)
);

coords
.slice(-count)
.forEach(
([r,c])=>{
board[r][c]=null;
}
);

tools.break--;

score=
Math.max(
0,
score-10
);

renderAll();

toast(
"💥 Blocks cleared."
);
}

function hasAnyEmptyCell(){

return board.some(
row=>
row.some(
v=>v===null
)
);
}

function failLevel(){

pauseRaceClock();

lives=
Math.max(
0,
lives-1
);

saveGameState();
updateStats();

$("failModal")
.classList
.remove("hidden");
}

function retryLevel(){

$("failModal")
.classList
.add("hidden");

startLevel();
startRaceClock(true);
saveGameState();
}

function winLevel(awardBonus=true){

pauseRaceClock();

const bonus=
LEVELS[level].size*100;

if(awardBonus&&!activeReplay){
score+=bonus;
saveGameState();
}

updateStats();

$("winInfo").textContent=
`Stage ${stage} · Level ${level+1} complete. +${bonus} bonus points.`;

$("winModal").querySelector("h1").textContent=
level===LEVELS.length-1?"STAGE COMPLETE!":"LEVEL COMPLETE!";

$("nextBtn").textContent=
level===LEVELS.length-1?"NEXT STAGE":"NEXT LEVEL";

$("winModal")
.classList
.remove("hidden");
}

async function submitScoreToServer(completedStage=stage,completedLevel=level+1,completedLevelSeconds=Math.floor(getLevelElapsedMs()/1000)){

if(
isGuest||
activeReplay||
!authToken
){
return;
}

try{

await api(
  "/api/leaderboard/submit",
  {
    method:"POST",
    body:JSON.stringify({
      token:authToken,
      stage:completedStage,
      level:completedLevel,
      score,
      elapsed_seconds:completedLevelSeconds
    })
  }
);


const me=
  await api(
    `/api/users/me?token=${encodeURIComponent(authToken)}`
  );


profile=me;

localStorage.setItem(
  PROFILE_KEY,
  JSON.stringify(profile)
);


$("bestLevel").textContent=
  profile.best_level||1;

$("bestStage").textContent=
  profile.best_stage||1;

$("bestScore").textContent=
  profile.best_score||0;

saveGameState();

}catch(e){

console.warn(
  "Score sync failed:",
  e.message
);

}
}

async function refreshServerLeaderboard(){

try{

const data=
  await api(
    "/api/leaderboard"
  );


if(data.items?.length){

  $("leaderboardList").innerHTML=
    data.items
      .slice(0,5)
      .map(
        (x,i)=>{

          const medal=
            ["🥇","🥈","🥉"][i]||
            `${i+1}`;


          return`
            <div class="lb-row">
              <span class="lb-rank">${medal}</span>
              <span class="lb-name">${x.username}<small class="lb-stage">Stage ${x.stage} · Level ${x.level}</small></span>
              <span class="lb-score">${Number(x.score).toLocaleString()}</span>
            </div>
          `;
        }
      )
      .join("");
}

}catch(e){

console.warn(
  "Leaderboard sync failed:",
  e.message
);

}
}

async function nextLevel(){

if(activeReplay){
$("winModal").classList.add("hidden");
restoreReplayState();
await showDashboard(dashboardSelectedStage);
return;
}

$("winModal")
.classList
.add("hidden");

const completedStageNumber=stage;
const completedLevelNumber=level+1;
const completedLevelSeconds=Math.floor(getLevelElapsedMs()/1000);
const completedStage=level===LEVELS.length-1;

race.completed=
Math.max(
Number(race.completed)||0,
(stage-1)*LEVELS.length+level+1
);

if(completedStage){
stage++;
level=0;
}else{
level++;
}

race.stage=stage;
race.level=level+1;

if(
!isGuest &&
typeof saveRace==="function"
){

saveRace();

}

renderLeaderboard();
updateRaceUI();

startLevel();
startRaceClock(true);
saveGameState();
toast(completedStage?`Stage ${completedStageNumber} complete! Stage ${stage} begins.`:`Stage ${stage} · Level ${level+1} started.`);

if(!isGuest){
clearTimeout(progressSaveTimer);
void submitScoreToServer(completedStageNumber,completedLevelNumber,completedLevelSeconds);
void saveServerProgress();
}
void refreshServerLeaderboard();
}

function updateProgress(){

const total=
board.length*board.length;

const filled=
board
.flat()
.filter(
v=>v!==null
)
.length;

$("progressText").textContent=
`${filled} / ${total}`;

$("progressText").title=
`Stage ${stage} · Level ${level+1} • ${board.length}×${board.length}`;

$("progressFill").style.width=
`${filled/total*100}%`;
}

function updateStats(){

$("stageNo").textContent=
stage;

$("levelNo").textContent=
level+1;

$("lives").textContent=
lives;

$("score").textContent=
score;

$("hammerCount").textContent=
tools.hammer;

$("breakCount").textContent=
tools.break;

$("hintCount").textContent=
tools.hint;

updateRaceUI();

renderLeaderboard();
}

let _raceTimerId=null;
let levelElapsedMs=0;
let levelTimerStartedAt=null;

function getLevelElapsedMs(){
return levelElapsedMs+(levelTimerStartedAt?Date.now()-levelTimerStartedAt:0);
}

function renderRaceClock(){
const totalSeconds=Math.floor(getLevelElapsedMs()/1000);
const hours=Math.floor(totalSeconds/3600);
const minutes=Math.floor((totalSeconds%3600)/60);
const seconds=totalSeconds%60;
$("raceTimer").textContent=hours
?`${String(hours).padStart(2,"0")}:${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`
:`${String(Math.floor(totalSeconds/60)).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`;
}

function startRaceClock(reset=false){
if(reset){
pauseRaceClock();
levelElapsedMs=0;
levelTimerStartedAt=null;
}
if(levelTimerStartedAt)return;
if($("game").classList.contains("hidden")||!$("dashboard").classList.contains("hidden"))return;

levelTimerStartedAt=Date.now();
renderRaceClock();
_raceTimerId=setInterval(renderRaceClock,250);
}

function pauseRaceClock(){
if(levelTimerStartedAt){
levelElapsedMs+=Date.now()-levelTimerStartedAt;
levelTimerStartedAt=null;
}
if(_raceTimerId){
clearInterval(_raceTimerId);
_raceTimerId=null;
}
renderRaceClock();
}

document.addEventListener("visibilitychange",()=>{
if(document.hidden){
pauseRaceClock();
return;
}
if(!$("game").classList.contains("hidden")&&$("dashboard").classList.contains("hidden")&&!document.querySelector(".modal:not(.hidden)")){
startRaceClock();
}
});

function loadRace(){

try{

const raw=
  localStorage.getItem(
    raceStateKey()
  );


if(raw){

  race=
    JSON.parse(raw);

}else{

  race={
    startedAt:Date.now(),
    completed:0
  };
}

}catch(e){

race={
  startedAt:Date.now(),
  completed:0
};

}
}

function saveRace(){

try{

localStorage.setItem(
  raceStateKey(),
  JSON.stringify(race)
);

}catch(e){}
}

async function renderLeaderboard(){

try{

await refreshServerLeaderboard();

}catch(e){}
}

function updateRaceUI(){

try{

if(!race){
  return;
}


$("raceLevel").textContent=
  `Stage ${stage} · Level ${level+1}`;


const total=
  (
    LEVELS[level]?.size||3
  )**2;


const filled=
  board.flat
    ?board
      .flat()
      .filter(
        v=>v!==null
      )
      .length
    :0;


$("raceFill").style.width=
  `${filled/total*100}%`;

}catch(e){}
}

$("hammerBtn").onclick=hammer;

$("breakBtn").onclick=
breakTool;

$("hintBtn").onclick=
showHint;

$("retryBtn").onclick=
retryLevel;

$("nextBtn").onclick=
nextLevel;

$("leaderboardBtn").onclick=()=>{
renderLeaderboard();
toast(
"🏆 Leaderboard refreshed."
);
};

$("raceContinueBtn").onclick=()=>{
$("raceModal")
.classList
.add("hidden");
};

loadProfile();