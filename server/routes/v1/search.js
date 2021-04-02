"use strict";

const S = require("fluent-json-schema");
const classes = require("../../enums/classes");
const regions = require("../../enums/regions");
/**
 * setup some routes
 * @param {import("fastify").FastifyInstance} fastify 
 * @param {*} options 
 */
async function searchReq(fastify, options) {
	const apiConfig = options.apiConfig;

	const responseSchema = S.array()
		.id("searchResponse2xx")
		.description("Cutted upload representation with basic info")
		.items(
			S.object()
				.additionalProperties(false)
				.prop("runId", S.string().required())
				.prop("encounterUnixEpoch", S.string().required())
				.prop("huntingZoneId", S.number().required())
				.prop("bossId", S.number().required())
				.prop("fightDuration", S.string().required())
				.prop("isP2WConsums", S.boolean().required())
				.prop("isMultipleTanks", S.boolean().required())
				.prop("isMultipleHeals", S.boolean().required())
				.prop("partyDps", S.string().required())
				.prop("members", S.array().required().items(
					S.object()
						.additionalProperties(false)
						.prop("playerClass", S.string().required())
						.prop("playerDps", S.string().required())
						.prop("playerName", S.string().required())
						.prop("playerServerId", S.string().required())
						.prop("playerId", S.string().required())

				))

		)
		.valueOf();

	const schemaRecent = {
		body: (S.object()
			.id("searchRecentPostRequestBody")
			.description("All available parameters for search in recent requests")
			.additionalProperties(false)
			.prop("region", S.string().enum(regions))
			.prop("huntingZoneId", S.number())
			.prop("bossId", S.number())
			.prop("isShame", S.boolean())
			.prop("playerClass", S.string().enum(Object.values(classes)))
			.prop("excludeP2wConsums", S.boolean())
		)
			.valueOf(),
		response: {
			"2xx": responseSchema
		}
	};

	const schemaByTop = {
		body: (S.object()
			.id("searchTopPostRequestBody")
			.description("All available parameters to search in top runs")
			.additionalProperties(false)
			.prop("region", S.string().enum(regions).required())
			.prop("huntingZoneId", S.number().required())
			.prop("bossId", S.number().required())
			.prop("playerClass", S.string().enum(Object.values(classes)).required())
			.prop("excludeP2wConsums", S.boolean())
		)
			.valueOf(),
		response: {
			"2xx": responseSchema
		}
	};

	const schemaFull = {
		body: (S.object()
			.additionalProperties(false)
			.prop("runId", S.string().required()))
			.valueOf(),
		response: {
			"2xx": (S.object()
				.id("completeUploadDbResponse")
				.additionalProperties(false)
				.prop("runId", S.string().required())
				.prop("bossId", S.number().required())
				.prop("huntingZoneId", S.number().required())
				.prop("region", S.string().required())
				.prop("encounterUnixEpoch", S.number().required())
				.prop("fightDuration", S.string().required())
				.prop("partyDps", S.string().required())
				.prop("isMultipleHeals", S.boolean().required())
				.prop("isMultipleTanks", S.boolean().required())
				.prop("debuffDetail", S.array().required())
				.prop("isShame", S.boolean().required())
				.prop("isP2WConsums", S.boolean().required())
				.prop("members", S.array().required().items(
					S.object()
						.prop("playerClass", S.string().enum(Object.values(classes)).required())
						.prop("playerName", S.string().required())
						.prop("playerId", S.number().required())
						.prop("playerServerId", S.number().required())
						.prop("aggro", S.number().required())
						.prop("playerAverageCritRate", S.number().required())
						.prop("playerDeathDuration", S.string().required())
						.prop("playerDeaths", S.number().required())
						.prop("playerDps", S.string().required())
						.prop("playerTotalDamage", S.string().required())
						.prop("playerTotalDamagePercentage", S.number().required())
						.prop("buffDetail", S.array().required())
						.prop("skillLog", S.array().required().items(
							S.object()
								.additionalProperties(false)
								.prop("skillAverageCrit", S.string())
								.prop("skillAverageWhite", S.string())
								.prop("skillCritRate", S.number())
								.prop("skillDamagePercent", S.number())
								.prop("skillHighestCrit", S.string())
								.prop("skillHits", S.string())
								.prop("skillCasts", S.string())
								.prop("skillId", S.number().required())
								.prop("skillLowestCrit", S.string())
								.prop("skillTotalDamage", S.string())
						))
				))
			)
				.valueOf()
		}
	};

	fastify.post("/search/recent", { prefix: options.prefix, config: options.config, schema: schemaRecent }, async (req) => {
		let params = { ...req.body };
		if (params.playerClass) {
			params["members.playerClass"] = params.playerClass;
			delete params.playerClass;
		}

		const [dbError, res] = await fastify.to(fastify.uploadModel.getLatestRuns(params, apiConfig.recentRunsAmount));

		if (res) {
			for (let j = 0; j < res.length; j++) {
				const run = res[j];
				for (let i = 0; i < run.members.length; i++) {
					run.members[i] = { ...run.members[i], ...run.members[i].userData };
				}
			}
		}

		if (dbError) throw fastify.httpErrors.internalServerError("Internal database error");

		return res;
	});

	fastify.post("/search/top", { prefix: options.prefix, config: options.config, schema: schemaByTop }, async (req) => {
		let params = { ...req.body };
		if (params.playerClass) {
			params["members.playerClass"] = params.playerClass;
			delete params.playerClass;
		}

		const [dbError, res] = await fastify.to(fastify.uploadModel.getTopRuns(params, apiConfig.topPlacesAmount));

		if (res) {
			for (let j = 0; j < res.length; j++) {
				const run = res[j];
				for (let i = 0; i < run.members.length; i++) {
					run.members[i] = { ...run.members[i], ...run.members[i].userData };
				}
			}
		}
		if (dbError) throw fastify.httpErrors.internalServerError("Internal database error");
		return res;
	});

	fastify.post("/search/id", { prefix: options.prefix, config: options.config, schema: schemaFull }, async (req) => {
		const [dbError, res] = await fastify.to(fastify.uploadModel.getCompleteRun(req.body.id));
		if (dbError) throw fastify.httpErrors.internalServerError("Internal database error");

		if (res) {
			for (let i = 0; i < res.members.length; i++) {
				res.members[i] = { ...res.members[i], ...res.members[i].userData };
			}
		}
		return res;
	});
}

module.exports = searchReq;