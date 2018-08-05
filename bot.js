require('dotenv').config(); //get the environment variables described in .env
const Telegraf = require('telegraf')
require('au5ton-logger')();
const prettyMs = require('pretty-ms');
const VERSION = require('./package').version;
const CronJob = require('cron').CronJob;
const fetch = require('node-fetch')
const querystring = require('querystring')

const START_TIME = new Date();
var BOT_USERNAME;

// Custom modules
const bot_util = require('./lib/bot_util');
const database = require('./lib/database');
const imdb = require('./lib/content');
const plexmediaserver = require('./lib/plex');
const notify = require('./lib/notify');
const User = require('./lib/classes/User');
const Request = require('./lib/classes/Request');

// Create a bot that uses 'polling' to fetch new updates
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
var job = null;

process.on('unhandledRejection', r => console.error('unhandledRejection: ',r.stack,'\n',r));

// Basic commands
bot.hears(new RegExp('\/start|\/start@' + BOT_USERNAME), (context) => {
	context.getChat().then((chat) => {
		if(chat.type === 'private') {

			// Give introduction and help with commands
			context.reply('Hello, I am Hastume. \n'
			+'If you want to make a request for something to be added to Plex, you\'ve come to the right place. '
			+'First things first, I need to verify that you actually have access to it already. '
			+'To start this process, use the /enroll command. '
			+'Once you\'re enrolled, you\'ll be able to make requests with the /makerequest command. '
			+'During any of these operations, you can use the /cancel command to stop and do something else.');
		}
	}).catch((err) => {
		//
	});
});

bot.hears(new RegExp('\/ping|\/ping@' + BOT_USERNAME), (context) => {
	context.reply('pong');
});
bot.hears(new RegExp('\/uptime|\/uptime@' + BOT_USERNAME), (context) => {
	context.reply(''+prettyMs(new Date() - START_TIME));
});

bot.hears(new RegExp('\/enroll|\/enroll@' + BOT_USERNAME), (context) => {
	database.users.checkFor('telegram_id', context.update.message.from.id).then(info => {
		if(info === 'found') {
			database.users.get('telegram_id', context.update.message.from.id).then(myUser => {
				if(myUser.plex_username === null) {
					if(myUser.chat_state === 0) {
						database.users.setState(myUser.telegram_id, 1).then(info => {
							context.reply('Please send your Plex.tv username (or email if you don\'t have one).');
						}).catch(err => console.error(err));
					}
					else {
						context.reply('Please send your Plex.tv username (or email if you don\'t have one).');
					}
				}
				else {
					context.reply('You\'re already enrolled.');
				}
			}).catch(err => console.error(err));;
		}
		else {
			database.users.init(context.update.message.from.id, context.update.message.from.first_name, context.update.message.from.username).then(info => {
				if(info === 'already added') {
					context.reply('You\'re already enrolled.');
				}
				else {
					context.reply('Please send your Plex.tv username (or email if you don\'t have one).');
				}
			});
		}
	});
});

bot.hears(new RegExp('\/unsubscribe|\/unsubscribe@' + BOT_USERNAME), (context) => {
	database.users.remove('telegram_id', context.update.message.from.id).then(info => {
		context.reply('You\'ve been removed from the database. Next time we talk it\'ll be like the first time we spoke.');
	}).catch(err => {
		//
	});
});

bot.on('message', (context) => {
	database.users.getState(context.update.message.from.id).then(chat_state => {
		bot_util.processMessage(context.update.message, chat_state).then((processed) => {
			// Optionally respond with multiple things at once
			for(let i in processed.responses) {
				context.reply(processed.responses[i].text, processed.responses[i].options);
				
				// Notify channel
				if(processed.responses[i].channelPayload !== undefined) {
					bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, processed.responses[i].channelPayload, processed.responses[i].options)
				}
			}
			
			// You can only send it to one state at a time
			if(processed.nextState !== null) {
				database.users.setState(context.update.message.from.id,processed.nextState).catch(err => console.error(err));
			}
			if(processed.extra === 'persistent_cancel') {
				persistent[context.update.message.from.id] = {last: -1, now: -1};
			}
		}).catch(err => console.error(err));
	}).catch(err => {
		//console.error('bot.on(message) failed for some weird reason: ',err)
	});
})


console.log('Bot active. Performing startup checks.');
let promises = [];

promises.push(new Promise((resolve, reject) => {
	console.ind().warn('Is our Telegram token valid?');
	bot.telegram.getMe().then((r) => {
		//doesn't matter who we are, we're good
		console.ind().success('Telegram token valid for @',r.username);
		resolve('passed');
		BOT_USERNAME = r.username;
		bot.startPolling();
	}).catch((r) => {
		resolve('failed')
	});
}));

promises.push(new Promise((resolve, reject) => {
	console.ind().warn('Is our database connection good?');
	database.users.get('telegram_handle','durov').then(user => {
		console.ind().success('Database connection good');
		resolve('passed')
	}).catch(err => {
		console.ind().error('Database connection failed: \n', err)
		resolve('failed')
	})
}))

promises.push(new Promise((resolve, reject) => {
	console.ind().warn('Is our OMDb connection good?');
	imdb.testIMDBConnection().then(tuple => {
		if(tuple.status === 'good') {
			console.ind().success('OMDb connection good.');
			resolve('passed')
		}
		else {
			console.ind().error('OMDb connection failed: \n', tuple.err)
			resolve('failed')
		}
	})
}))

promises.push(new Promise((resolve, reject) => {
	console.ind().warn('Is our TheTVDB connection good?');
	imdb.testTVDBConnection().then(tuple => {
		if(tuple.status === 'good') {
			console.ind().success('TheTVDB connection good.');
			resolve('passed')
		}
		else {
			console.ind().error('TheTVDB connection failed: \n', tuple.err)
			resolve('failed')
		}
	})
}))

promises.push(new Promise((resolve, reject) => {
	console.ind().warn('Is our Plex connection good?');
	plexmediaserver.testConnection().then(tuple => {
		if(tuple.status === 'good') {
			console.ind().success('Plex connection good.');
			resolve('passed')
		}
		else {
			console.ind().error('Plex connection failed: \n', tuple.err)
			resolve('failed')
		}
	})
}))

promises.push(new Promise((resolve, reject) => {
	console.ind().warn('Is our themoviedb.org connection good?')
	// Test with "Finding Nemo" (example from TMDb API)
	fetch('https://api.themoviedb.org/3/find/tt0266543?'+querystring.encode({
		api_key: process.env.THEMOVIEDB_API_KEY,
		external_source: 'imdb_id'
	}))
	.then(res => {
		if(res.status === 200) {
			console.ind().success('TMDb connection good.')
			resolve('passed')
		}
		else {
			console.ind().error('TMDb connection failed.')
			resolve('failed')
		}
	})
}))

Promise.all(promises).then(results => {
	let checks_passed = 0;
	for(let i in results) {
		if(results[i] === 'passed') {
			checks_passed++;
		}
	}
	if(results.length - checks_passed > 0) {
		console.warn(checks_passed+'/'+results.length+' tests passed.')
		console.warn('Exiting...');
		process.exit()
	}
	else {
		console.success(checks_passed+'/'+results.length+' tests passed.')
	}

	// Safe to check
	// Check for satisfied requests every 20 minutes
	// */20 * * * *
	let job = new CronJob('*/20 * * * *', () => {
		
		// calculate filled requests
		notify.filledRequests().then(filled => {
			for(let i in filled) {
				bot.telegram.sendMessage(filled[i]['telegram_id'], '⚡️ <b>'+filled[i]['content_name']+(filled[i]['start_year'] === null ? '':' ('+filled[i]['start_year']+')')+' has been added!</b> (＾▽＾)', {
					parse_mode: 'html',
					disable_web_page_preview: true
				})
			}
			for(let i in filled) {
				database.requests.removeOneByIds(filled[i]['telegram_id'], 'content_name', filled[i]['content_name']).then(info => {
					console.log('Removed '+filled[i]['telegram_id']+'/'+filled[i]['content_name']+' from the database')
				})
				.catch(err => {
					console.log('Failed to remove '+filled[i]['telegram_id']+'/'+filled[i]['content_name']+' from the database')
				})
			}
		})
		

	}, notify.stop, true, 'America/Chicago');

	// Query DB every 4 seconds (I'd like to make this shorter, but I'd like to keep no more than one instance running at once)
	let composition_checker = setInterval(() => {
		console.log('composition_checker()')
		//console.log('doin the thing')
		// React to new compositions
		database.requests.getMultiple('done_composing', false)
		.then(requests => {
			
			// Get all users
			let users = new Set()
			for(let i in requests) {
				users.add(requests[i]['telegram_id'])
			}

			for(let item of users) {
				if(persistent[item] === undefined) {
					persistent[item] = compose_default();
				}
				// Get their oldest request_id
				for(let i = 0; i < requests.length; i++) {
					if(requests[i]['telegram_id'] === item) {
						persistent[item].now = requests[i]['request_id'];
						break;
					}
				}
			}
			//console.log(persistent)

			for(let item of users) {
				// If the oldest request_id
				if(persistent[item].now !== persistent[item].last) {
					console.magenta('new request: '+persistent[item].now)
					database.requests.getMultiple('request_id',persistent[item].now).then(r => {
						// Interact with the user
						bot.telegram.sendMessage(r[0]['telegram_id'],generateTVCompositionMessage(r[0]),{
							parse_mode: 'html',
							disable_web_page_preview: false,
							reply_markup: generateInlineKeyboardMarkup(r[0])
						})
						.then(message => {
							console.log(message.chat.id+'/'+message.message_id+' => '+r[0].request_id)
							message_to_request.set(message.chat.id+'/'+message.message_id, r[0].request_id)
						})
						.catch(err => {
							console.error(err)
							console.error(err.on.payload.reply_markup)
						})
					})
				}
				persistent[item].last = persistent[item].now;
			}
		})
		.catch(err => {
			if(err === 'error/requests.getmulitple: results array empty') {
				// nothing out of the ordinary
			}
			else {
				// ok, what fucked up?
			}
		})
	},4000)
});

function generateTVCompositionMessage(request) {
	const empty_char = '&#8203;'
	const television = '📺';
	
	// just like: https://github.com/au5ton/Roboruri/blob/f032f6afad9dcb2b381ac9a4f5ee155c09d17daf/roboruri/bot_util.js#L394-L443
	let message = '';
	if(request['image'] && request['image'].startsWith('http')) {
		message += '\n<a href=\"'+request['image']+'\">'+empty_char+'</a>';
	}
	message += television + ' <b>' + request['content_name'] + '</b>\n';
	message += 'Please tap to check which seasons you\'re interested in. When you\'ve picked all that are applicable, press Done.';
	return message
}
// [[{text: 'specials', data: 'specials'}]]
function generateInlineKeyboardMarkup(request) {
	let keyboard = []
	let seasons = request['available_seasons'];
	let wanted = request['desired_seasons'];
	for(let i in seasons) {
		let n = (seasons[i] < 10 ? 'S0'+seasons[i] : 'S'+seasons[i]); // make it 2 characters long for style
		if(seasons[i] === 0) {
			keyboard.push({
				text: (wanted.includes(seasons[i]) ? 'Specials ☑️' : 'Specials ⬜️'),
				callback_data: 'S'+seasons[i]
			})
		}
		else {
			keyboard.push({
				// S01 ☑️
				// S01 ⬜️
				text: (wanted.includes(seasons[i]) ? n+' ☑️' : n+' ⬜️'),
				callback_data: 'S'+seasons[i]
			})
		}
	}
	keyboard.push({
		text: 'All',
		callback_data: 'all'
	})
	keyboard.push({
		text: 'Done',
		callback_data: 'done'
	})

	//Resize (1,n) array to (2,n/2) array
	matrix = new Array(Math.ceil(keyboard.length / 2)).fill(0)
	// Matrix should have exactly the same indexes as original array
	for(let i in matrix) {
		matrix[i] = new Array(2).fill(0)
	}
	let i = 0;
	console.log('matrix before: ',matrix)
	for(let r = 0; r < matrix.length; r++) {
		for(let c = 0; c < matrix[r].length; c++) {
			//console.log(keyboard[i])
			matrix[r][c] = keyboard[i];
			console.log(matrix[r][c])
			i++;
		}
	}
	i = 0;
	//console.log('keyboard: ',keyboard)
	for(let r = 0; r < matrix.length; r++) {
		for(let c = 0; c < matrix[r].length; c++) {
			if(matrix[r][c] === undefined) {
				matrix[r].splice(c,1); // remove the empty index that happens when keyboard.length is an odd number
			}
		}
	}
	console.log('matrix: ',matrix)

	return {inline_keyboard: matrix};
}
function compose_default() {
	return {
		last: -1,
		now: -1
	}
}
// In-memory caching of user whereabouts
var persistent = {
	'0': compose_default() //durov
};
//  '{chat_id}/{message_id}' => request_id
var message_to_request = new Map()

bot.on('callback_query', (context) => {
	// Explicit usage
	context.telegram.answerCbQuery(context.callbackQuery.id,'request_id: '+message_to_request.get(context.callbackQuery.message.chat.id+'/'+context.callbackQuery.message.message_id))

	//https://core.telegram.org/bots/api#callbackquery
	//context.callbackQuery.message is undefined if the message is too old

	// Doing this removes the buttons from the original message
	//context.telegram.editMessageText(context.callbackQuery.message.chat.id, context.callbackQuery.message.message_id, context.callbackQuery.inline_message_id, '🔥')

	
	//
	//context.telegram.editMessageReplyMarkup(context.callbackQuery.message.chat.id, context.callbackQuery.message.message_id, context.callbackQuery.inline_message_id, '🔥')
	//console.log(context)
})