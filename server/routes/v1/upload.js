/* eslint-disable no-unused-vars */
"use strict";

const S = require("fluent-json-schema");
const readable = require("readable-url");

const NodeCache = require("node-cache");
const classes = require("../../enums/classes");
const status = require("../../enums/statuses");
const strings = require("../../enums/strings");

/*const fs = require("fs");
const util = require("util");
const path = require("path");
const { pipeline } = require("stream");
const pump = util.promisify(pipeline);*/

// eslint-disable-next-line node/no-unpublished-require
const readableIdGenerator = new readable(true, 5, "");

const arraysHasIntersect = (arr1, arr2) => {
	for (const item of arr1)
		if (arr2.indexOf(item) != -1) return true;
	return false;
};

const generateUniqKey = (payload) => {
	let playersIds = (payload.members.map(player => player.playerId)).sort();
	let playersServerIds = (payload.members.map(player => player.playerServerId)).sort();

	return `${payload.bossId}${payload.areaId}${playersIds.join("")}${playersServerIds.join("")}`;
};

/**
 *  Upload route
 * @param {import("fastify").FastifyInstance} fastify 
 * @param {*} options 
 */
async function uploadReq(fastify, options) {
	const prefix = options.prefix;
	const apiConfig = options.apiConfig;
	const whitelist = options.whitelist;
	const regions = options.regions;
	const analyze = options.analyze;
	const authHeader = options.apiConfig.authCheckHeader.toLowerCase();

	const uploadsCache = new NodeCache({ stdTTL: apiConfig.maxAllowedTimeDiffSec, checkperiod: 30, useClones: false });
	//const timelineAccess = new NodeCache({ stdTTL: apiConfig.maxAllowedTimelineUploadTimeSec, checkperiod:apiConfig.maxAllowedTimelineTimeSec / 2, useClones: false });

	const isPlacedInCache = (str) => uploadsCache.has(str);
	const placeInCache = (str) => uploadsCache.set(str);

	//const isAllowedToUploadTimeline = (str) => timelineAccess.has(str);
	//const allowUploadTimeline = (str) => timelineAccess.set(str);
	//const removeFromTimelineAccess = (str) => timelineAccess.del(str);

	const schema = {
		body: (S.object()
			.id("completeUploadPostRequest")
			.additionalProperties(false)
			.prop("bossId", S.integer().minimum(0).required())
			.prop("areaId", S.integer().minimum(0).required())
			.prop("encounterUnixEpoch", S.integer().required())
			.prop("fightDuration", S.string().minLength(2).required())
			.prop("partyDps", S.string().minLength(5).required())
			.prop("debuffDetail", S.array().required())
			.prop("uploader", S.string().required())
			.prop("members", S.array().required().items(
				S.object()
					.prop("playerClass", S.string().enum(Object.values(classes)).required())
					.prop("playerName", S.string().minLength(3).required())
					.prop("playerId", S.integer().minimum(1).required())
					.prop("playerServerId", S.integer().required())
					.prop("playerServer", S.string().required())
					.prop("aggro", S.integer().minimum(0).required())
					.prop("playerAverageCritRate", S.integer().minimum(1).required())
					.prop("playerDeathDuration", S.string().minLength(1).required())
					.prop("playerDeaths", S.integer().minimum(0).maximum(999).required())
					.prop("playerDps", S.string().required())
					.prop("playerTotalDamage", S.string().required())
					.prop("playerTotalDamagePercentage", S.integer().required())
					.prop("buffDetail", S.array().required())
					.prop("skillLog", S.array().required().items(
						S.object()
							.additionalProperties(false)
							.prop("skillAverageCrit", S.string())
							.prop("skillAverageWhite", S.string())
							.prop("skillCritRate", S.integer())
							.prop("skillDamagePercent", S.integer())
							.prop("skillHighestCrit", S.string())
							.prop("skillHits", S.string())
							.prop("skillCasts", S.string())
							.prop("skillId", S.integer().required())
							.prop("skillLowestCrit", S.string())
							.prop("skillTotalDamage", S.string())
							.prop("skillTotalCritDamage", S.string())
					))
			))
		)
			.valueOf(),
		headers: (
			S.object()
				.prop(authHeader, S.string().minLength((apiConfig.allowAnonymousUpload) ? 0 : 20).maxLength(50))
		)
			.valueOf(),
		response: {
			"2xx": (
				S.object()
					.prop("id", S.string())
			)
				.valueOf(),
		}
	};

	/*const schemaTimeline = {
		headers: (
			S.object()
				.additionalProperties(false)
				.prop(authHeader, S.string().minLength(20).maxLength(50).required())
		)
			.valueOf(),
		params: (
			S.object()
				.additionalProperties(false)
				.prop("id", S.string().minLength(20).maxLength(50).required())
		)
			.valueOf(),
	};*/

	const prereqsCheck = (payload) => {
		const currServerTimeSec = Date.now() / 1000;
		const timeDataDiff = Math.abs(Math.round(currServerTimeSec) - Math.round(payload.encounterUnixEpoch));

		//allowed time diff 
		if (timeDataDiff > apiConfig.maxAllowedTimeDiffSec)
			return {
				reason: `time diff (server ${currServerTimeSec}, client ${payload.encounterUnixEpoch}, diff ${timeDataDiff})`,
				status: false
			};
		
		//allowed huntingZone and boss
		const huntingZoneId = whitelist[payload.areaId];
		if (!huntingZoneId || !huntingZoneId.bosses || (huntingZoneId && huntingZoneId.bosses && Array.isArray(huntingZoneId.bosses) && huntingZoneId.bosses.length > 0 && !huntingZoneId.bosses.includes(payload.bossId))) {
			return {
				reason: strings.UPLOADRESERRHZ,
				status: false
			};
		}
		
		//check damage validity 
		const totalDmg = payload.members.reduce((prev, cur) => prev + Number(cur.playerTotalDamage), 0);
		const bossHp = huntingZoneId.hp[huntingZoneId.bosses.indexOf(payload.bossId)];
		if(totalDmg && bossHp) {
			if(Math.abs(bossHp - totalDmg) > Math.round((bossHp/100) * 18)) {
				return {
					reason: strings.UPLOADRESERRHPBOUND,
					status: false
				};
			}
		}

		//compare party dps
		const partyDps = Number(payload.partyDps);
		if (partyDps < apiConfig.minPartyDps) 
			return {
				reason: strings.UPLOADRESERRLOWDPS,
				status: false
			};

		//compare members amounts
		if (payload.members.length < apiConfig.minMembersCount || payload.members.length > apiConfig.maxMembersCount) 
			return {
				reason: strings.UPLOADRESERRINCORERCTCOUNTER,
				status: false
			};

		//check validity of uploader
		const uploader = Number(payload.uploader);
		if ( uploader > payload.members.length || uploader < 0)
			return {
				reason: strings.UPLOADRESERRFAKEUPLOADER,
				status: false
			};
		
		//check debuffs
		if (!Array.isArray(payload.debuffDetail) || (Array.isArray(payload.debuffDetail) && payload.debuffDetail.length === 0)) 
			return {
				reason: strings.UPLOADRESERRABNCOUNT,
				status: false
			};

		//check buffs 
		// eslint-disable-next-line unicorn/no-array-for-each
		payload.members.forEach( member => {
			if (!Array.isArray(member.buffDetail) || (Array.isArray(member.buffDetail) && member.buffDetail.length === 0)) 
				return {
					reason: strings.UPLOADRESERRABNCOUNT,
					status: false
				};
		});

		return {
			reason: status.OK,
			status: true
		};
	};

	const analyzePayload = (payload) => {
		let tanksCounter = 0;
		let healersCounter = 0;
		let deaths = 0;
		let region = "";
		let specialBuffs = false; 

		for (const member of payload.members) {
			const pcls = member.playerClass;
			const buffs = member.buffDetail.map(element => element[0]);
			deaths += member.playerDeaths;

			if(arraysHasIntersect(analyze.p2wAbnormals, buffs)) specialBuffs = true;

			// eslint-disable-next-line unicorn/prefer-switch
			if (pcls === classes.PRIEST || pcls === classes.MYSTIC)
				healersCounter += 1;
			else if (pcls === classes.BRAWLER || pcls === classes.WARRIOR || pcls === classes.BERS) {
				if (arraysHasIntersect(analyze.tankAbnormals, buffs))
					tanksCounter += 1;
			}
			else if (pcls === classes.LANCER)
				tanksCounter += 1;
		}

		region = regions[payload.members[0].playerServer];
		
		return {
			isShame: deaths >= analyze.isShameDeathsAmount,
			isMultipleTanks: tanksCounter >= analyze.minMultipleTanksTriggerAmount,
			isMultipleHeals: healersCounter >= analyze.minMultipleHealsTriggerAmount,
			isP2WConsums: specialBuffs,
			region: region
		};
	};
	
	const controlledClasses = new Set([classes.BRAWLER, classes.WARRIOR,classes.BERS]);
	const modifyMembersArray = (members) => {
		let membersArray = [];
		for (const item of members) {
			const cls = item.playerClass;
			const buffs = item.buffDetail.map(el => el[0]);
			if(controlledClasses.has(cls)){
				let newObj = {...item};
				const roleType = analyze.roleType[cls];
				if(arraysHasIntersect(roleType.abns[0], buffs))
					newObj.roleType = roleType.abns[1];
				else
					newObj.roleType = roleType.default;
				membersArray.push(newObj);
			}
			else {
				membersArray.push(item);
			}
		}

		return membersArray;
	};


	const updatePlayerOrAddAndReturfRef = async (playerRaw) => {
		let ref = await fastify.playerModel.getFromDbLinked(playerRaw.playerServerId, playerRaw.playerId, playerRaw.playerClass);
	
		if (ref) {
			if (ref.playerName !== playerRaw.playerName) {
				ref.playerName = playerRaw.playerName;
				await ref.save();
			}
		} else if (!ref) {
			let newPlayerRef = new fastify.playerModel({
				playerClass: playerRaw.playerClass,
				playerName: playerRaw.playerName,
				playerId: playerRaw.playerId,
				playerServerId: playerRaw.playerServerId,
				playerServer: playerRaw.playerServer
			});

			await newPlayerRef.save();

			ref = await fastify.playerModel.getFromDbLinked(playerRaw.playerServerId, playerRaw.playerId, playerRaw.playerClass);
		}

		return ref;
	};

	const isAuthTokenInDb = async (header) => {
		if(!header) return false;

		return await fastify.apiModel.getFromDb(header);
	};

	fastify.post("/upload", { prefix, config: options.config, schema }, async (req) => {
		const payload = req.body;
		const header = req.headers[authHeader].trim();

		if (!apiConfig.allowAnonymousUpload) {
			const [authCheckDbError, dbres] = await fastify.to(isAuthTokenInDb(header));
			if (authCheckDbError) fastify.httpErrors.forbidden(strings.DBERRSTR);
			if (!dbres) throw fastify.httpErrors.forbidden(strings.AUTHERRSTR);
		}

		//basic validation of data
		let check = prereqsCheck(payload);
		if (!check.status) throw fastify.httpErrors.forbidden(`${strings.UPLOADLOADERRSTR } ${ check.reason}`);
		//Fast check in cache by uniq string gathered in payload without accessing database
		if (isPlacedInCache(generateUniqKey(payload))) 
			throw fastify.httpErrors.forbidden(strings.UPLOADDUPERRSTR);
		placeInCache(generateUniqKey(payload));

		const [uploaderDbError, uploader] = await fastify.to(updatePlayerOrAddAndReturfRef(payload.members[Number(payload.uploader)]));
		if (uploaderDbError) throw fastify.httpErrors.internalServerError(strings.DBERRSTR);
		
		const analyzeRes = analyzePayload(payload);
		//create db view
		let dbView = new fastify.uploadModel(payload);
		const runId = readableIdGenerator.generate();
		dbView.runId = runId;
		dbView.region = analyzeRes.region;
		dbView.huntingZoneId = payload.areaId;
		dbView.uploader = uploader;
		dbView.isShame = analyzeRes.isShame;
		dbView.isMultipleTanks = analyzeRes.isMultipleTanks;
		dbView.isMultipleHeals = analyzeRes.isMultipleHeals;
		dbView.isP2WConsums = analyzeRes.isP2WConsums;

		dbView.members = [];
		const modifiedMembers = modifyMembersArray(payload.members);

		for (const member of modifiedMembers) {
			const [memberDbError, ref] = await fastify.to(updatePlayerOrAddAndReturfRef(member));
			if (memberDbError) throw fastify.httpErrors.internalServerError(strings.DBERRSTR);
			const obj = member;
			obj.userData = ref;
			dbView.members.push(obj);
		}

		const [saveUploadDbError, res] = await fastify.to(dbView.save());
		if (saveUploadDbError) throw fastify.httpErrors.internalServerError(strings.DBERRSTR);

		//allowUploadTimeline(`${header}-${runId}`);

		return { 
			id: `https://teralogs.tera-asura.ru/details/${runId}`,
			//timelineLink: `https://teralogs.tera-asura.ru/v1/upload/timeline/${runId}`
		};
	});
	
	// eslint-disable-next-line unicorn/consistent-function-scoping
	/*const isPathWithoutInvalidCharacters = (paramsPath) => {
		if (paramsPath.indexOf("\0") !== -1 || paramsPath.indexOf("../") || paramsPath.indexOf("./") !== -1)
			return false;
		else 
			return true;
	};

	fastify.post("/upload/timeline/:id", { prefix, config: options.config, schema: schemaTimeline }, async (req) => {
		if (!req.isMultipart())	throw fastify.httpErrors.forbidden(strings.CONTENTTPERR);

		const header = req.body.headers[authHeader].trim();
		const runId = req.params.id.trim();

		const key = `${header}-${runId}`;
		
		if (!isAllowedToUploadTimeline(key))
			throw fastify.httpErrors.forbidden(strings.AUTHERRSTR);
		
		removeFromTimelineAccess(key);

		const file = await req.file({ limits: { files: 1 }});
		if (!file) throw fastify.httpErrors.forbidden(strings.NOTFOUNDERRSTR);

		await pump(file.file, fs.createWriteStream(`${runId}.gzip`));

		return { status: status.OK };
	});*/
}

module.exports = uploadReq;