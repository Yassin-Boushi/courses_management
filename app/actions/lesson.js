"use server"

import { replaceMongoIdInObject } from "@/lib/convertData";
import { Lesson } from "@/model/lesson.model";
import { Module } from "@/model/module.model";
import { create } from "@/queries/lessons";
import { lessonSchema } from "@/lib/validations";
import mongoose from "mongoose";
import { getLoggedInUser } from "@/lib/loggedin-user";
import { dbConnect } from "@/service/mongo";

// ينشئ درسًا جديدًا؛ يصبح محتواه لاحقًا مصدرًا يمكن تضمينه للـAI Tutor.
export async function createLesson(data){
    await dbConnect();
    try {
        const user = await getLoggedInUser();
        if (!user) {
            throw new Error('Unauthorized: Please log in');
        }
        
        const title = data.get("title");
        const slug = data.get("slug");
        const moduleId = data.get("moduleId");
        const order = data.get("order");

        if (!title || !moduleId) {
            throw new Error('Title and module ID are required');
        }

        // Verify ownership of the module before creating lesson
        const { assertInstructorOwnsModule } = await import('@/lib/authorization');
        await assertInstructorOwnsModule(moduleId, user.id, user);

        const createdLesson = await create({title,slug,order});

        const module = await Module.findById(moduleId);
        if (!module) {
            throw new Error('Module not found');
        }
        
        module.lessonIds.push(createdLesson._id);
        await module.save();

        return replaceMongoIdInObject(createdLesson);
        
    } catch (error) {
        throw new Error(error?.message || 'Failed to create lesson');
    }
}

// يعيد ترتيب الدروس داخل Module دون تغيير محتوى الـRAG.
export async function reOrderLesson(data){
    await dbConnect();
    try {
        const user = await getLoggedInUser();
        if (!user) {
            throw new Error('Unauthorized: Please log in');
        }
        
        // Verify ownership of all lessons being reordered
        const { verifyOwnsAllLessons } = await import('@/lib/authorization');
        const lessonIds = data.map(element => element.id);
        await verifyOwnsAllLessons(lessonIds, user.id, user);
        
        await Promise.all(data.map(async(element) => {
            await Lesson.findByIdAndUpdate(element.id, {order: element.position});
        }));
    } catch (error) {
        throw new Error(error?.message || 'Failed to reorder lessons');
    }
}

/** BOLA: ownership via assertInstructorOwnsLesson. Mass assignment: only title, slug, order. */
// يحدث الدرس ثم يزامن embeddings عندما يتغير المحتوى الذي يعتمد عليه AI Tutor.
export async function updateLesson(lessonId, data) {
    await dbConnect();
    try {
        const user = await getLoggedInUser();
        if (!user) {
            throw new Error('Unauthorized: Please log in');
        }
        const { assertInstructorOwnsLesson } = await import('@/lib/authorization');
        await assertInstructorOwnsLesson(lessonId, user.id, user);
        const updateSchema = lessonSchema.partial().strict();
        const parsed = updateSchema.safeParse(data);
        if (!parsed.success) {
            throw new Error('Validation failed for lesson update');
        }
        const allowed = parsed.data;
        if (Object.keys(allowed).length === 0) return;

        const existingLesson = await Lesson.findById(lessonId)
            .select("docxFilename")
            .lean();

        await Lesson.findByIdAndUpdate(lessonId, { $set: allowed }, { runValidators: true });

        if (allowed.description !== undefined && !existingLesson?.docxFilename) {
            const { syncLessonEmbeddings } = await import("@/service/lecture-embedder");
            const courseId =
                (await Module.findOne({ lessonIds: lessonId }).select("course").lean())
                    ?.course?.toString() ?? null;
            if (courseId) {
                try {
                    await syncLessonEmbeddings(lessonId, courseId);
                } catch (embedError) {
                    console.error("[UPDATE_LESSON] Embedding sync failed:", embedError);
                }
            }
        }
    } catch (error) {
        throw new Error(error?.message || 'Failed to update lesson');
    }
}

// يغير نشر الدرس، مما يؤثر في إتاحة محتوى الدرس للطلاب فقط.
export async function changeLessonPublishState(lessonId) {
    await dbConnect();
    try {
        const user = await getLoggedInUser();
        if (!user) {
            throw new Error('Unauthorized: Please log in');
        }
        
        // Verify ownership via lesson -> module -> course chain
        const { assertInstructorOwnsLesson } = await import('@/lib/authorization');
        await assertInstructorOwnsLesson(lessonId, user.id, user);
        
        const lesson = await Lesson.findById(lessonId);
        if (!lesson) {
            throw new Error('Lesson not found');
        }
        
        const res = await Lesson.findByIdAndUpdate(
            lessonId, 
            [{ $set: { active: { $not: "$active" } } }],
            { new: true, lean: true }
        );
        return res?.active ?? false;

    } catch (error) {
        throw new Error(error?.message || 'Failed to change lesson publish state');
    }
}

// يحذف الدرس وعلاقته بـModule، ويجب أن يمنع بقاء محتوى RAG غير صالح.
export async function deleteLesson(lessonId, moduleId){
    await dbConnect();
    try {
        const user = await getLoggedInUser();
        if (!user) {
            throw new Error('Unauthorized: Please log in');
        }
        
        // Verify ownership via lesson -> module -> course chain
        const { assertInstructorOwnsLesson } = await import('@/lib/authorization');
        await assertInstructorOwnsLesson(lessonId, user.id, user);
        
        const module = await Module.findById(moduleId);
        if (!module) {
            throw new Error('Module not found');
        }
        
        module.lessonIds.pull(new mongoose.Types.ObjectId(lessonId));

        const courseId = module.course?.toString?.() ?? null;
        if (courseId) {
            try {
                const { removeLessonEmbeddings } = await import("@/service/lecture-embedder");
                await removeLessonEmbeddings(lessonId, courseId);
            } catch (embedError) {
                console.error("[DELETE_LESSON] Failed to remove embeddings:", embedError);
            }
        }

        try {
            const { cleanupLessonDocxFiles } = await import("@/lib/lesson-docx-files");
            await cleanupLessonDocxFiles(lessonId);
        } catch (fileError) {
            console.error("[DELETE_LESSON] Failed to remove lesson docx files:", fileError);
        }

        await Lesson.findByIdAndDelete(lessonId);
        await module.save();
    } catch (error) {
        throw new Error(error?.message || 'Failed to delete lesson');
    }
}

// يعيد للواجهة حالة وعدد chunks الخاصة بتضمين الدرس.
export async function getLessonEmbeddingStatusAction(lessonId) {
    await dbConnect();
    try {
        const user = await getLoggedInUser();
        if (!user) {
            throw new Error("Unauthorized: Please log in");
        }

        const { assertInstructorOwnsLesson } = await import("@/lib/authorization");
        await assertInstructorOwnsLesson(lessonId, user.id, user);

        const { getLessonEmbeddingStatus } = await import("@/service/lecture-embedder");
        return getLessonEmbeddingStatus(lessonId);
    } catch (error) {
        throw new Error(error?.message || "Failed to load embedding status");
    }
}

// يعيد تشغيل مزامنة embeddings بعد تحقق ملكية المدرس للدرس.
export async function retryLessonEmbeddingAction(lessonId) {
    await dbConnect();
    try {
        const user = await getLoggedInUser();
        if (!user) {
            throw new Error("Unauthorized: Please log in");
        }

        const { retryLessonDocxEmbedding } = await import("@/lib/lesson-docx-retry");
        return retryLessonDocxEmbedding(lessonId, user.id, user);
    } catch (error) {
        throw new Error(error?.message || "Failed to retry embedding");
    }
}



 
