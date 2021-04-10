/* eslint-disable no-unused-vars */
"use strict";

const S = require("fluent-json-schema");
const readable = require("readable-url");

const NodeCache = require("node-cache");
const classes = require("../../enums/classes");
const status = require("../../enums/statuses");

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
	const authHeader = options.apiConfig.authCheckHeader;

	const uploadsCache = new NodeCache({ stdTTL: apiConfig.maxAllowedTimeDiffSec, checkperiod: 30, useClones: false });

	const isPlacedInCache = (str) => uploadsCache.has(str);
	const placeInCache = (str) => uploadsCache.set(str);

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
				.prop(authHeader, S.string().minLength(20).maxLength(50))
		)
			.valueOf(),
		response: {
			"2xx": fastify.getSchema("statusResSchema")
		}
	};

	const prereqsCheck = (payload) => {
		const currServerTimeSec = Date.now() / 1000;
		const timeDataDiff = currServerTimeSec - payload.encounterUnixEpoch;

		//allowed time diff 
		if (timeDataDiff > apiConfig.maxAllowedTimeDiffSec || timeDataDiff < 0) return false;
		
		//allowed huntingZone and boss
		const huntingZoneId = whitelist[payload.areaId];
		if (!huntingZoneId || (huntingZoneId && Array.isArray(huntingZoneId) && huntingZoneId.length > 0 && !huntingZoneId.includes(payload.bossId))) return false;

		//compare party dps dps
		const partyDps = BigInt(payload.partyDps);
		if (partyDps > BigInt(apiConfig.maxPartyDps) || partyDps < BigInt(apiConfig.minPartyDps)) return false;

		//compare members amounts
		if (payload.members.length < apiConfig.minMembersCount || payload.members.length > apiConfig.maxMembersCount) return false;

		//check validity of uploader
		if (Number(payload.uploader) > payload.members.length || Number(payload.uploader) < 0) return false;
		
		//check buffs and debuffs
		if (!Array.isArray(payload.debuffDetail) || (Array.isArray(payload.debuffDetail) && payload.debuffDetail.length === 0)) return false;

		payload.members.forEach( member => {
			if (!Array.isArray(member.buffDetail) || (Array.isArray(member.buffDetail) && member.buffDetail.length === 0)) return false;
		});

		return true;
	};

	const analyzePayload = (payload) => {
		let tanksCounter = 0;
		let healersCounter = 0;
		let deaths = 0;
		let region = "";
		payload.members.forEach(member => {
			const pcls = member.playerClass;
			deaths += member.playerDeaths;
			if (pcls === classes.PRIEST || pcls === classes.MYSTIC)
				healersCounter += 1;
			else if (pcls === classes.BRAWLER || pcls === classes.WARRIOR || pcls === classes.BERS) {
				const buffs = member.buffDetail.map(el => el[0]);

				if (arraysHasIntersect(analyze.tankAbnormals, buffs)) tanksCounter += 1;
			}
			else if (pcls === classes.LANCER) tanksCounter += 1;
		});

		region = regions[payload.members[0].playerServer];
		
		return {
			isShame: deaths >= analyze.isShameDeathsAmount,
			isMultipleTanks: tanksCounter >= analyze.minMultipleTanksTriggerAmount,
			isMultipleHeals: healersCounter >= analyze.minMultipleHealsTriggerAmount,
			isP2WConsums: false,
			region: region
		};
	};

	const modifyMembersArray = (members) => {
		let membersArray = [];
		const controlledClasses = [classes.BRAWLER, classes.WARRIOR,classes.BERS];
		members.forEach(item => {
			const cls = item.playerClass;
			const buffs = item.buffDetail.map(el => el[0]);
			if(controlledClasses.includes(cls)){
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
		});

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

	const isAuthTokenInDb = async (headers) => {
		if(!headers[authHeader]) return false;
		return !!(await fastify.apiModel.getFromDb(headers[authHeader].toString().trim()));
	};

	fastify.post("/upload", { prefix, config: options.config, schema }, async (req) => {

		if (!apiConfig.allowAnonymousUpload) {
			const [authCheckDbError, dbres] = await fastify.to(isAuthTokenInDb(req.headers));
			if (authCheckDbError) fastify.httpErrors.forbidden("Internal database error");
			if (!dbres) throw fastify.httpErrors.forbidden("Invalid auth");
		}

		//basic validation of data
		if (!prereqsCheck(req.body)) throw fastify.httpErrors.forbidden("Can't accept this upload");
		//Fast check in cache by uniq string gathered in payload without accessing database
		if (isPlacedInCache(generateUniqKey(req.body))) 
			throw fastify.httpErrors.forbidden("Upload was already registered.");
		placeInCache(generateUniqKey(req.body));

		const [uploaderDbError, uploader] = await fastify.to(updatePlayerOrAddAndReturfRef(req.body.members[Number(req.body.uploader)]));
		if (uploaderDbError) throw fastify.httpErrors.internalServerError("Internal database error");
		
		const analyzeRes = analyzePayload(req.body);
		//create db view
		let dbView = new fastify.uploadModel(req.body);
		dbView.runId = readableIdGenerator.generate();
		dbView.region = analyzeRes.region;
		dbView.huntingZoneId = req.body.areaId;
		dbView.uploader = uploader;
		dbView.isShame = analyzeRes.isShame;
		dbView.isMultipleTanks = analyzeRes.isMultipleTanks;
		dbView.isMultipleHeals = analyzeRes.isMultipleHeals;
		dbView.isP2WConsums = analyzeRes.isP2WConsums;

		dbView.members = [];

		const modifiedMembers = modifyMembersArray(req.body.members);

		for (const member of modifiedMembers) {
			const [memberDbError, ref] = await fastify.to(updatePlayerOrAddAndReturfRef(member));
			if (memberDbError) throw fastify.httpErrors.internalServerError("Internal database error");
			const obj = member;
			obj.userData = ref;
			dbView.members.push(obj);
		}

		const [saveUploadDbError, res] = await fastify.to(dbView.save());
		if (saveUploadDbError) throw fastify.httpErrors.internalServerError("Internal database error");

		return { status: status.OK };
	});
}

module.exports = uploadReq;