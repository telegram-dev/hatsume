// bot_util.js

require('au5ton-logger')();

const database = require('./database');
const plexmediaserver = require('./plex');
const imdb = require('./content');

const _ = {};

// returns (response, nextState)
_.processMessage = async function (message, chat_state) {

    var cmd = null;
    if (_.isCommand(message)) {
        cmd = _.getCommand(message);
    }

    try {
        if (message.chat.type === 'private') {
            // See: `img/chat_state diagram.png`
            switch (chat_state) {
                case 0: {
                    //[idle], user hasn't enrolled or cancelled their enrollment process

                    /** Redundant, see bot.js **/
                    /** This can't happen here because we don't store Telegram users 
                     * in the database until they opt-in, therefore we can't retrieve a chat_state **/
                    // if(cmd === '/enroll') {
                    //     //telegram_id, telegram_name, telegram_handle
                    //     resolve({
                    //         response: 'Please send your Plex.tv username (or email if you don\'t have one).',
                    //         nextState: 1
                    //     });
                    //     break;
                    // }
                    if (cmd === '/makerequest') {
                        return {
                            responses: [{
                                text: 'Before making a request, you must verify that you have access to the Plex server by providing your Plex username with the /enroll command.'
                            }],
                            nextState: null
                        }
                    }

                }
                case 1: {
                    //attempting to enroll, expecting a Plex username
                    if (cmd === '/cancel') {
                        return {
                            responses: [{
                                text: 'Enrollment process cancelled.'
                            }],
                            nextState: 0
                        }
                    }

                    try {
                        var checked = await plexmediaserver.getUserFromLogin(message.text.trim())
                    }
                    catch (err) {
                        console.log(err)
                    }
                    // if a user was retreived with the provided username_or_email
                    if (checked.status === 'found') {

                        //asynchronously check if anyone is registered with this username_or_email already
                        let user_checks = await database.users.checkFor('plex_username', checked.payload['username'])
                        let email_checks = await database.users.checkFor('plex_username', checked.payload['email'])
                        user_checks.concat(email_checks)

                        for (let i in user_checks) {
                            //if someone was already registered with this username
                            if (user_checks[i] === 'found') {
                                return {
                                    responses: [{
                                        text: 'That Plex.tv username is already in use. Please try another or use /cancel to cancel.'
                                    }],
                                    nextState: null,
                                }
                            }
                        }
                        //if the username_or_email is valid and hasn't been used before
                        try {
                            await database.users.update('telegram_id', message.from.id, {
                                plex_username: message.text.trim()
                            })
                        }
                        catch (err) {
                            console.error(err)
                        }
                        return {
                            responses: [{
                                text: 'Your Plex.tv username is valid and has been confirmed. You may now use /makerequest to make requests for content additions.'
                            }],
                            nextState: 2
                        }
                    }
                    else {
                        return {
                            responses: [{
                                text: 'That Plex.tv username was not valid. Please try again or use /cancel to cancel.'
                            }],
                            nextState: null,
                        }
                    }

                }
                case 2: {
                    //user is authenticated, [idleing] and waiting to make a formal request

                    if (cmd === '/makerequest') {
                        return {
                            responses: [{
                                text: 'Send a link to the content you\'re interested in on imdb.com or thetvdb.com. (You can send multiple links in one message) \nExample: https://www.imdb.com/title/tt0213338/\nhttps://www.thetvdb.com/series/cowboy-bebop',
                                options: {
                                    disable_web_page_preview: true
                                }
                            }],
                            nextState: 3
                        }
                    }

                    break;
                }
                case 3: {
                    //attempting to request, expecting an @imdb message, an imdb link, or thetvdb link

                    if (cmd === '/cancel') {
                        return {
                            responses: [{
                                text: 'Request cancelled.'
                            }],
                            nextState: 2
                        }
                    }


                    // Attempts to retrieve the links that the user sent
                    let links = _.getContentLinks(message);
                    if (links.length === 0) {
                        return {
                            responses: [{
                                text: 'I couldn\'t find any links in that message. Try again or use /cancel.'
                            }],
                            nextState: null
                        }
                    }

                    // Separates the urls we're interested in
                    let valid_ids = [];
                    for (let i in links) {
                        let u = new URL(links[i]);
                        if (u.hostname === 'www.imdb.com' || u.hostname === 'imdb.com' || u.hostname === 'm.imdb.com') {
                            //(regex.exec(str))[0] => 'tt2560140'
                            //bad.exec(str) => null
                            let regex = /tt\d{7}/gm;
                            let r = regex.exec(links[i]);
                            if (r !== null) {
                                valid_ids.push(r[0]);
                            }
                        }
                        else if ((u.hostname === 'www.thetvdb.com' || u.hostname === 'thetvdb.com') && u.pathname.startsWith('/series/')) {
                            valid_ids.push(links[i])
                        }
                    }

                    // Checks if the user sent any URLs that are useful
                    if (valid_ids.length === 0) {
                        return {
                            responses: [{
                                text: 'Those urls aren\'t a link to a movie or tv show. Try again or use /cancel.'
                            }],
                            nextState: null
                        }
                    }
                    else {

                        // Starts processing the valid urls
                        let requests = [];
                        for (let i in valid_ids) {
                            // if the string is an IMDb id
                            if (valid_ids[i].startsWith('tt')) {
                                requests.push(await imdb.getRequestFromIMDBId(valid_ids[i]));
                            }
                            else {
                                //otherwise it's a TVDB url
                                requests.push(await imdb.getRequestFromTVDBUrl(valid_ids[i]));
                            }
                        }

                        let cant_cross_reference = _.sanitizeRequests(requests); //removes bad requests from original object

                        if (requests.length === 0) {
                            return {
                                response: [{
                                    text: 'Those IMDb url(s) may be a real links, but I can\'t get any information about them right now. If they are TV shows, try sending me the thetvdb.com url instead. Try again or use /cancel.'
                                }],
                                nextState: null
                            }
                        }

                        for (let i in requests) {
                            requests[i]['telegram_id'] = message.from.id;

                            if (requests[i].is_tv) {
                                requests[i].done_composing = false;
                            }
                        }
                        //console.log(requests)

                        let movies = _.justMovies(requests);
                        let shows = _.justShows(requests);

                        // Submit to database
                        let database_queries = [];
                        for (let i in requests) {
                            database_queries.push(await database.requests.add(requests[i]))
                        }

                        // Build response for failed cross-references
                        let cross = '';
                        if (cant_cross_reference.length > 0) {
                            for (let i in cant_cross_reference) {
                                cross += '<i>' + cant_cross_reference[i]['title'] + ' (' + cant_cross_reference[i]['_year_data'] + ')' + '</i>' + ', \n';
                            }
                            cross = cross.substring(0, cross.length - 3)
                        }
                        else {
                            delete cross;
                        }

                        // all were added to the database
                        // Repond to the user

                        let tv_dupes = [];

                        for (let i in database_queries) {
                            if (database_queries[i].status === 'duplicate' && database_queries[i].request['is_tv']) {
                                //console.log('dupe: ', database_queries[i].request)
                                // keep track of this duplicate
                                tv_dupes.push(database_queries[i].request)
                                // Remove the duplicate from the pool of valid tv compositions
                                for (let j = shows.length - 1; j >= 0; j--) {
                                    //console.log(shows[i]['tvdb_id'],'===',database_queries[i].request['tvdb_id'],' => ',shows[i]['tvdb_id'] === database_queries[i].request['tvdb_id'])
                                    if (shows[j]['tvdb_id'] === database_queries[i].request['tvdb_id']) {
                                        let spliced = shows.splice(j, 1)
                                        console.log('spliced: ', spliced)
                                    }
                                }
                            }
                        }
                        //console.log(shows)

                        let replies = [];

                        if (movies.length > 0) {
                            //console.warn('i satisfied this fucking condition')
                            let str = _.buildPrettyResponse(movies);
                            replies.push({
                                text: (cant_cross_reference.length === 0 ? 'Done! Requested: \n\n' + str + '\n\nI\'ll send you a message whenever these item(s) get added. (＾◡＾)' : 'Done! Requested: \n\n' + str + '\n\nI\'ll send you a message whenever these item(s) get added. (＾◡＾)\n\nUnfortunately, I couldn\'t cross reference these shows. You\'ll need to send me links to these shows as they are on thetvdb.com instead: \n\n' + cross),
                                options: {
                                    parse_mode: 'html',
                                    disable_web_page_preview: true
                                },
                                channelPayload: message.from.first_name + ' requests: \n' + str
                            })
                        }

                        if (tv_dupes.length > 0) {
                            let str = _.buildPrettyResponse(tv_dupes)
                            replies.push({
                                text: 'Some of the TV show(s) you\'ve requested are duplicates:\n\n' + str,
                                options: {
                                    parse_mode: 'html',
                                    disable_web_page_preview: true
                                }
                            })
                        }

                        if (shows.length > 0) {
                            let str = _.buildPrettyResponse(shows)
                            replies.push({
                                text: 'You requested TV show(s), I\'ll need you to supply some more information about them.',
                                options: {
                                    parse_mode: 'html',
                                    disable_web_page_preview: true
                                },
                                channelPayload: message.from.first_name + ' requests: \n' + str
                            })
                        }

                        //If there are shows to get more info on: nextState => 4
                        //If we're done here: nextState => 2
                        return {
                            responses: replies,
                            nextState: (shows.length > 0 ? 4 : 2)
                        }
                    }
                }
                case 4: {
                    //user is authenticated, currently composing TV requests
                    if (cmd === '/cancel') {
                        //TODO: REMOVE DATABASE REQUESTS WHERE telegram_id=message.from.id AND done_composing=false
                        await database.requests.cancelAllCompositions(message.from.id)
                        return {
                            responses: [{
                                text: 'Composing process cancelled.'
                            }],
                            nextState: 2,
                            extra: 'persistent_cancel'
                        }
                    }
                }
            }
        }
    }
    catch (err) {
        console.error(err)
        return {
            responses: [{
                text: 'I had an unexpected error occur. Try doing what did again and then tell my maintainer about it.'
            }],
            nextState: null
        }
    }

};

// Synchronous function determines if message is a command or not
_.isCommand = (message) => {
    for (let e in message.entities) {
        if (message.entities[e].type === 'bot_command') {
            return true;
        }
    }
    return false;
};

// Only gets first command
_.getCommand = (message) => {
    for (let i = 0; i < message.entities.length; i++) {
        if (message.entities[i].type === 'bot_command') {
            return _.getEntity(message, i)['entity_text'];
        }
    }
    return null;
}

// Returns MessageEntity with extra property `entity_text` from offset and length
// https://core.telegram.org/bots/api#messageentity
_.getEntity = (message, index) => {
    let ent = message.entities[index];
    ent.entity_text = message.text.substring(ent.offset, ent.offset + ent.length);
    return ent;
};

// Returns array
_.getContentLinks = (message) => {
    //console.log(message)
    let links = [];
    for (let e in message.entities) {
        if (message.entities[e].type === 'text_link') {
            links.push(message.entities[e].url);
        }
        if (message.entities[e].type === 'url') {
            links.push((_.getEntity(message, e))['entity_text']);
        }
    }
    return links;
}

/**
 * 
 * @param {Request[]} requests 
 * @returns {Request[]} cant_cross_reference
 */
_.sanitizeRequests = (requests) => {
    let cant_cross_reference = [];
    // traverse the requests backwards because we might remove some
    for (let i = requests.length - 1; i >= 0; i--) {

        // if the request really was on IMDB (null response => broken imdb link)
        if (requests[i] !== null && requests[i] !== undefined) {
            // if the request was a tv show that couldn't be looked up on TVDB
            if (requests[i].status === 404) {
                cant_cross_reference.push(requests[i]._imdb_entry);
                /* 
                This DOES persist even though you're modifying a parameter because you're modifying the original object.
                If you were to set `requests` to something else here, you would create a pointer to a new object, which
                wouldn't persist in the scope of whereever sanitizeRequests was called

                See: https://gist.github.com/au5ton/fd2c2fb8497821b1a14e5184c513bfe0
                */
                requests.splice(i, 1) // remove "faulty" requests
            }
        }
        else {
            // request is 'null' or 'undefined'
            requests.splice(i, 1);
        }
    }

    return cant_cross_reference
};

/**
 * 
 * @param {Request[]} requests 
 * @returns {String} a pretty response string
 */
_.buildPrettyResponse = (requests) => {
    let str = '';
    for (let i in requests) {
        // Make a pretty string
        str += '<i>'
        str += requests[i]['content_name'] + ' (' + requests[i]['start_year'] + ') ';
        str += '</i>'
        // if the request has a tvdb_url, display it
        if (requests[i]['_tvdb_url']) {
            str += '[<a href=\"' + requests[i]['_tvdb_url'] + '\">TVDB</a>]';
        }
        // if the request has an imdb_url, display it
        if (requests[i]['_imdb_entry'] && requests[i]['_imdb_entry']['imdburl']) {
            str += '[<a href=\"' + requests[i]['_imdb_entry']['imdburl'] + '\">IMDB</a>]';
        }
        if (requests[i]['tmdb_id']) {
            str += '[<a href=\"' + (requests[i]['is_tv'] ? 'https://www.themoviedb.org/tv/' + requests[i]['tmdb_id'] : 'https://www.themoviedb.org/movie/' + requests[i]['tmdb_id']) + '\">TheMovieDB</a>]';
        }
        str += ', \n';
    }
    str = str.substring(0, str.length - 3); //remove trailing ', \n'
    return str;
}

/**
 * 
 * @param {Request[]} requests 
 * @returns {Request[]} just movies
 */
_.justMovies = (requests) => {
    let movies = [];
    for (let i in requests) {
        if (requests[i].is_tv === false) {
            movies.push(requests[i]);
        }
    }
    return movies;
}

/**
 * 
 * @param {Request[]} requests 
 * @returns {Request[]} just shows
 */
_.justShows = (requests) => {
    let shows = [];
    for (let i in requests) {
        if (requests[i].is_tv === true) {
            shows.push(requests[i]);
        }
    }
    return shows;
}

module.exports = _;