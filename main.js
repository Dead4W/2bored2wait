// imports
const fs = require('fs');
const mc = require('minecraft-protocol'); // to handle minecraft login session
const notifier = require('node-notifier'); // Required to send desktop notifications

// someone decided to use webserver as a variable to store other data, ok.
const webserver = require('./webserver/webserver.js'); // to serve the webserver
const opn = require('open'); //to open a browser window
const {
	DateTime
} = require("luxon");
const https = require("https");
const everpolate = require("everpolate");
const mcproxy = require("@icetank/mcproxy");
const queueData = require("./queue.json");
const util = require("./util");

let config;

try {
	config = require("config");
} catch (err) {
	if (String(err).includes("SyntaxError: ")) {
		console.error("The syntax in your config file is not correct. Make sure you replaced all values as the README says under 'How to Install' step 5. If it still does not work, check that all quotes are closed. You can look up the json syntax online. Please note that the comments are no problem although comments are normally not allowed in json. " + err)
		process.exit(1);
	}
}

let mc_username;
let mc_password;
let savelogin;
let accountType;
let launcherPath;
let c = 150;
let finishedQueue = false

const rl = require("readline").createInterface({
	input: process.stdin,
	output: process.stdout
});
const promisedQuestion = (text) => {
	return new Promise((resolve) => rl.question(text, resolve))
}

const askForSecrets = async () => {
	let localConf = {};
	const config_dir = process.env["NODE_CONFIG_DIR"] ?? 'config';
	try {
		localConf = util.readJSON(config_dir + '/local.json');
	} catch (err) {
		if (err.code !== "ENOENT") throw err;
	}
	let canSave = false;
	if (!(config.has("username") && config.has("mcPassword"))) {
		canSave = true;
		accountType = ((await promisedQuestion("Account type, mojang (1) or microsoft (2) [1]: ")) === "2" ? "microsoft" : "mojang");
		if (accountType === "mojang") {
			mc_username = await promisedQuestion("Email: ");
			mc_password = await promisedQuestion("Password: ");
		} else {
			mc_username = await promisedQuestion("Email: ");
			mc_password = ""
		}
		localConf.accountType = accountType;
		localConf.mcPassword = mc_password;
		localConf.username = mc_username;
	}

	if (canSave) {

		savelogin = await promisedQuestion("Save login for later use? Y or N [N]: ");
		if (savelogin.toLowerCase() === "y") {
			fs.writeFile(config_dir + '/local.json', JSON.stringify(localConf, null, 2), (err) => {
				if (err) console.log(err);
			});
		}
		console.clear();
	}

	console.log(`Finished setting up 2b2w. Type "Start" to start the queue. Type "Help" for the list of commands.`);
	cmdInput();
	joinOnStart();
}

if (!config.get("minecraftserver.onlinemode")) {
	cmdInput();
} else {
	mc_username = config.username;
	mc_password = config.mcPassword;
	launcherPath = config.profilesFolder;
	accountType = config.get("accountType");
	askForSecrets();
}

let stoppedByPlayer = false;
let timedStart;
let starttimestring;
let options;
let doing;
let interval = {};
let queueStartPlace;
let queueStartTime;
webserver.restartQueue = config.get("reconnect.notConnectedQueueEnd");
webserver.onstart(startQueuing);
webserver.onstop(stopQueing);
if (config.get("webserver")) {
	let webPort = config.get("ports.web");
	webserver.createServer(webPort, config.get("address.web")); // create the webserver
	webserver.password = config.password
	if (config.get("openBrowserOnStart")) opn('http://localhost:' + webPort); //open a browser window
}
// lets
let proxyClient; // a reference to the client that is the actual minecraft game
let client; // the client to connect to 2b2t
let server; // the minecraft server to pass packets
let conn; // connection object from mcproxy for the client variable
let proxyPackets = [];

options = {
	host: config.get("minecraftserver.hostname"),
	port: config.get("minecraftserver.port"),
	version: config.get("minecraftserver.version")
}

function cmdInput() {
	rl.question("$ ", (cmd) => {
		userInput(cmd, false);
		cmdInput();
	});
}

// function to disconnect from the server
function stop() {
	webserver.isInQueue = false;
	finishedQueue = false
	webserver.queuePlace = "None";
	webserver.ETA = "None";
	if (client) {
		client.end(); // disconnect
	}
	if (proxyClient) {
		proxyClient.end("Stopped the proxy."); // boot the player from the server
	}
	if (server) {
		server.close(); // close the server
	}
}

// function to start the whole thing
function startQueuing() {
	stopQueing();
	doing = "auth";
	if (config.get("minecraftserver.onlinemode")) {
		options.username = mc_username;
		options.password = mc_password;
		options.profilesFolder = launcherPath;
		options.auth = accountType;
	} else {
		options.username = config.get("minecraftserver.username");
	}
	conn = new mcproxy.Conn(options); // connect to 2b2t
	client = conn.stateData.bot._client;
	join();
}

function join() {
	let lastQueuePlace = "None";
	let notisend = false;
	let positionError = false;
	let displayEmail = config.get("displayEmail")
	let notificationsEnabled = config.get("desktopNotifications.enabled");
    const threshold = config.get("desktopNotifications.threshold");
	doing = "queue"
	webserver.isInQueue = true;

	proxyPackets = [];

	client.on("packet", (data, meta) => { // each time 2b2t sends a packet
		if (!['encryption_begin', 'compress', 'success', ''].includes(meta.name) && proxyPackets.length < 50) {
			proxyPackets.push([
				meta.name,
				data,
			]);
		}

		switch (meta.name) {
			case "playerlist_header":
				if (!finishedQueue) { // if the packet contains the player list, we can use it to see our place in the queue
					let message_header = JSON.parse(data.header);
					let position_in_queue = "None";

					try {
						for (let line of message_header['extra']) {
							if (line.text.match(/position in queue/ui)) {
								position_in_queue = Number(line['extra'][0]['text']);
							}
						}
					} catch (e) {
						if (e instanceof TypeError && (positionError !== true)) {
							console.log("Reading position in queue from tab failed! Is the queue empty, or the server isn't 2b2t?");
							positionError = true;
						}
					}

					webserver.queuePlace = position_in_queue; // update info on the web page

					if (lastQueuePlace === "None" && position_in_queue !== "None") {
						console.log(`Position in queue: ${position_in_queue}`);

						queueStartPlace = position_in_queue;
						queueStartTime = DateTime.local();
					}

					if (position_in_queue !== "None" && lastQueuePlace !== position_in_queue) {
						let totalWaitTime = getWaitTime(queueStartPlace, 0);
						let timepassed = getWaitTime(queueStartPlace, position_in_queue);
						let ETAmin = (totalWaitTime - timepassed) / 60;
						server.favicon = config.has("favicon") ? config.get("favicon") : fs.readFileSync("favicon.png").toString("base64");
						server.motd = `Place in queue: ${webserver.queuePlace} ETA: ${webserver.ETA}`; // set the MOTD because why not
						webserver.ETA = Math.floor(ETAmin / 60) + "h " + Math.floor(ETAmin % 60) + "m";
						webserver.finTime = new Date((new Date()).getTime() + ETAmin * 60000);

						if (position_in_queue <= threshold && notificationsEnabled){
						notifier.notify({// Send the notification
                            title: 'Your queue is ' + threshold + '!',
                            message: 'Your queue is ' + threshold + '!',
							sound: true,
							wait: true});
							notificationsEnabled = false};// The flag is set to false to prevent the notification from being shown again
					}
					lastQueuePlace = position_in_queue;
				}
				break;
			case "chat":
				if (finishedQueue === false) { // we can know if we're about to finish the queue by reading the chat message
					// we need to know if we finished the queue otherwise we crash when we're done, because the queue info is no longer in packets the server sends us.
					let chatMessage = JSON.parse(data.message).text;
					if (chatMessage === 'Queued for server main.' || chatMessage === 'You are already queued to server main.') {
						console.log("2B2T says: " + chatMessage);
					}
					if (chatMessage === "Connected to the server.") {
						if (config.get("expandQueueData")) {
							queueData.place.push(queueStartPlace);
							let timeQueueTook = DateTime.local().toSeconds() - queueStartTime.toSeconds();
							let b = Math.pow(c / (queueStartPlace + c), 1 / timeQueueTook);
							queueData.factor.push(b);
							fs.writeFile("queue.json", JSON.stringify(queueData), "utf-8", (err) => {
								log(err);
							});
						}
						if (webserver.restartQueue && proxyClient == null) { //if we have no client connected and we should restart
							stop();
							reconnect();
						} else {
							finishedQueue = true;
							webserver.queuePlace = "FINISHED";
							webserver.ETA = "NOW";
						}
					}
				}
				break;
		}
	});

	// set up actions in case we get disconnected.
	const onDisconnect = () => {
		if (proxyClient) {
			proxyClient.end("Connection reset by 2b2t server.\nReconnecting...");
			proxyClient = null
		}
		stop();
		if (!stoppedByPlayer) {
			log(`Connection reset by 2b2t server. Reconnecting...`);
			if (!config.has("MCpassword") && !config.has("password")) log("If this ^^ message shows up repeatedly, it is likely a problem with your token being invalidated. Please start minecraft manually or use credential authentication instead.");
		}
		if (config.reconnect.onError) setTimeout(reconnect, 30000);
	}
	client.on('end', onDisconnect);
	client.on('error', onDisconnect);

	server = mc.createServer({ // create a server for us to connect to
		'online-mode': config.get("whitelist"),
		encryption: true,
		host: config.get("address.minecraft"),
		port: config.get("ports.minecraft"),
		version: config.MCversion,
		'max-players': maxPlayers = 1
	});

	server.on('login', (newProxyClient) => { // handle login
		if (config.whitelist && client.uuid !== newProxyClient.uuid) {
			newProxyClient.end("not whitelisted!\nYou need to use the same account as 2b2w or turn the whitelist off");
			return;
		}
		newProxyClient.on('packet', (_, meta, rawData) => { // redirect everything we do to 2b2t
			filterPacketAndSend(rawData, meta, client);
		});
		newProxyClient.on("end", () => {
			proxyClient = null;
		})

		for (let packet of proxyPackets) {
			let packetName = packet[0];
			let packetParams = packet[1];

			if (isSendablePacket(packetName)) {
				continue;
			}

			if ('entityId' in packetParams) {
				packetParams['entityId'] = conn.stateData.bot.entity.id;
			}

			newProxyClient.write(packetName, packetParams);
		}

		conn.link(newProxyClient);
		proxyClient = newProxyClient;
	});
}


function log(logmsg) {
	if (config.get("logging")) {
		fs.appendFile('2bored2wait.log', DateTime.local().toLocaleString({
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}) + "	" + logmsg + "\n", err => {
			if (err) console.error(err)
		})
	}
	let line = rl.line;
	process.stdout.write("\033[F\n" + logmsg + "\n$ " + line);
}

function reconnect() {
	doing = "reconnect";
	if (stoppedByPlayer) stoppedByPlayer = false;
	else {
		reconnectLoop();
	}
}

function reconnectLoop() {
	mc.ping({
		host: config.minecraftserver.hostname,
		port: config.minecraftserver.port
	}, (err) => {
		if (err) setTimeout(reconnectLoop, 3000);
		else startQueuing();
	});
}

//function to filter out some packets that would make us disconnect otherwise.
//this is where you could filter out packets with sign data to prevent chunk bans.
function filterPacketAndSend(data, meta, dest) {
	if (isSendablePacket(meta.name)) {
		dest.writeRaw(data);
	}
}

function isSendablePacket(name) {
	// keep alive packets are handled by the client we created, so if we were to forward them, the minecraft client would respond too and the server would kick us for responding twice.
	return name !== "keep_alive"
		&& name !== "update_time"
		&& name !== 'custom_payload'; // some can error
}

function userInput(cmd, DiscordOrigin, discordMsg) {
	// this makes no sense, some commands reply to discord bot some log to console?
	cmd = cmd.toLowerCase();
	switch (cmd) {
		case "help":
		case "commands":
			console.log(" help: Lists available commands.");
			console.log(" start 14:00: Start queue at 2pm.");
			console.log(" play 8:00: Tries to calculate the right time to join so you can play at 8:00am.");
			console.log(" start: Starts the queue.");
			console.log(" loop: Restarts the queue if you are not connect at the end of it");
			console.log(" loop status: Lets you know if you have reconnect on or off.")
			console.log(" update: Sends an update to the current channel with your position and ETA.");
			console.log(" url: displays the github url");
			console.log(" stop: Stops the queue.");
			console.log(" exit or quit: Exits the application.");
			console.log(" stats: Displays your health and hunger.");
			break;
		case "stats":
			try {
				if (conn.bot.health == undefined && conn.bot.food == undefined){
					console.log("Unknown.")
					break;}
				else
				{if (conn.bot.health == 0)
					console.log("Health: DEAD");
				else
					console.log("Health: " + Math.ceil(conn.bot.health)/2 + "/10");
					if (conn.bot.food == 0)
						console.log("Hunger: STARVING");
					else
						console.log("Hunger: " + conn.bot.food/2 + "/10");}
			} catch (err)
			{console.log(`Start 2B2W first with "Start".`)}
			break;

		case "url":
			console.log("https://github.com/themoonisacheese/2bored2wait");
			break;

		case "loop":
			console.log("Syntax: status, enable, disable");
			break;
		case "loop status":
			if (webserver.restartQueue)
				console.log("Loop is enabled");
			else
				console.log("Loop is disabled");
			break;
		case "loop enable":
			if (webserver.restartQueue)
				console.log("Loop is already enabled!");
			else {
				webserver.restartQueue = true
				console.log("Enabled Loop");
			}
			break;
		case "loop disable":
			if (!webserver.restartQueue)
				console.log("Loop is already disabled!");
			else {
				webserver.restartQueue = false
				console.log("Disabled Loop");
			}
			break;

		case "start":
			startQueuing();
			msg(DiscordOrigin, discordMsg, "Queue", "Queue is starting up");
			break;

		case "exit":
		case "quit":
			return process.exit(0);

		case "update":
			switch (doing) {
				case "queue":
					msg(DiscordOrigin, discordMsg, "Reconnecting", `Position: ${webserver.queuePlace} \n Estimated time until login: ${webserver.ETA}`);
					console.log(`Position: ${webserver.queuePlace} Estimated time until login: ${webserver.ETA}`);
					console.log(`Debug proxy packets length: ${proxyPackets.length}`);
					break;
				case "timedStart":
					msg(DiscordOrigin, discordMsg, "Timer", "Timer is set to " + starttimestring);
					break;
				case "reconnect":
					msg(DiscordOrigin, discordMsg, "Reconnecting", "2b2t is currently offline. Trying to reconnect");
					break;
				case "auth":
					let authMsg = "Authentication";
					msg(DiscordOrigin, discordMsg, authMsg, authMsg);
					break;
				case "calcTime":
					msg(DiscordOrigin, discordMsg, "Calculating time", "Calculating the time, so you can play at " + starttimestring);
					break;
			}
			break;
		case "stop":
			switch (doing) {
				case "queue":
					stopQueing();
					stopMsg(DiscordOrigin, discordMsg, "Queue");
					break;
				case "timedStart":
					clearTimeout(timedStart);
					stopMsg(DiscordOrigin, discordMsg, "Timer");
					break;
				case "reconnect":
					clearInterval(interval.reconnect);
					stopMsg(DiscordOrigin, discordMsg, "Reconnecting");
					break;
				case "auth":
					clearInterval(interval.auth);
					stopMsg(DiscordOrigin, discordMsg, "Authentication");
					break;
				case "calcTime":
					clearInterval(interval.calc);
					stopMsg(DiscordOrigin, discordMsg, "Time calculation");
					break;
			}
			break;
		default:
			if (/start (\d|[0-1]\d|2[0-3]):[0-5]\d$/.test(cmd)) {
				doing = "timedStart"
				timedStart = setTimeout(startQueuing, timeStringtoDateTime(cmd).toMillis() - DateTime.local().toMillis());

				msg(DiscordOrigin, discordMsg, "Timer", "Queue is starting at " + starttimestring);
			} else if (/^play (\d|[0-1]\d|2[0-3]):[0-5]\d$/.test(cmd)) {
				timeStringtoDateTime(cmd);
				calcTime(cmd);
				msg(DiscordOrigin, discordMsg, "Time calculator", "The perfect time to start the queue will be calculated, so you can play at " + starttimestring);

			} else msg(DiscordOrigin, discordMsg, "Error", `Unknown command. Type "Help" for the list of commands.`);
	}
}

function stopMsg(discordOrigin, discordMsg, stoppedThing) {
	msg(discordOrigin, discordMsg, stoppedThing, stoppedThing + " is **stopped**");
}

function msg(discordOrigin, msg, title, content) {
	if (discordOrigin) sendDiscordMsg(msg.channel, title, content);
	else console.log(content);
}

function timeStringtoDateTime(time) {
	starttimestring = time.split(" ");
	starttimestring = starttimestring[1];
	let starttime = starttimestring.split(":");
	let startdt = DateTime.local().set({
		hour: starttime[0],
		minute: starttime[1],
		second: 0,
		millisecond: 0
	});
	if (startdt.toMillis() < DateTime.local().toMillis()) startdt = startdt.plus({
		days: 1
	});
	return startdt;
}

function calcTime(msg) {
	https.get('https://2b2t.io/api/queue', function (res) {
		doing = "calcTime"
		interval.calc = setInterval(function () {
			https.get("https://2b2t.io/api/queue", (resp) => {
				let data = '';
				resp.on('data', (chunk) => {
					data += chunk;
				});
				resp.on("end", () => {
					data = JSON.parse(data);
					let queueLength = data[0][1];
					let playTime = timeStringtoDateTime(msg);
					let waitTime = getWaitTime(queueLength, 0);
					if (playTime.toSeconds() - DateTime.local().toSeconds() < waitTime) {
						startQueuing();
						clearInterval(interval.calc);
						console.log(waitTime);
					}
				});
			}).on("error", (err) => {
				log(err)
			});
		}, 60000);
	}).on('error', function (e) {
		console.log(`2b2t.io is currently offline. Please try again later to use the "play" command.`)
	});
}


function stopQueing() {
	stoppedByPlayer = true;
	stop();
}

function joinOnStart() {
	if (config.get("joinOnStart")) setTimeout(startQueuing, 1000);
}

function getWaitTime(queueLength, queuePos) {
	let b = everpolate.linear(queueLength, queueData.place, queueData.factor)[0];
	return Math.log((queuePos + c) / (queueLength + c)) / Math.log(b); // see issue 141
}
process.on('uncaughtException', err => {
	const boxen = require("boxen")
	console.error(err);
	console.log(boxen(`Something went wrong! Feel free to contact us on discord or github! \n\n Github: https://github.com/themoonisacheese/2bored2wait \n\n Discord: https://discord.next-gen.dev/`, {title: 'Something Is Wrong', titleAlignment: 'center', padding: 1, margin: 1, borderStyle: 'bold', borderColor: 'red', backgroundColor: 'red', align: 'center'}));
	console.log('Press any key to exit');
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on('data', process.exit.bind(process, 0));
});

module.exports = {
	startQueue: startQueuing,
	stop: stopQueing,
};
