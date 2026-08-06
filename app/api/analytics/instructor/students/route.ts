import { NextResponse } from "next/server";
import { z } from "zod";
import {
  analyticsAuthErrorResponse,
  assertCourseOwnership,
  requireInstructor,
} from "@/lib/analytics/auth";
import { paginationSchema } from "@/lib/analytics/schemas";
import { getStudentProgress } from "@/service/analytics/instructor-analytics.service";

const studentsQuerySchema = paginationSchema.and(
  z.object({
    courseId: z.string().min(1),
    status: z
      .enum(["not-started", "in-progress", "near-completion", "completed"])
      .optional(),
    sortBy: z
      .enum(["name", "progress", "lastActivity", "enrollmentDate"])
      .optional()
      .default("lastActivity"),
    sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
  })
);

/**
 * GET /api/analytics/instructor/students
 * Privacy-limited student progress for an owned course (FR-008).
 */
export async function GET(request: Request) {
  try {
    const user = await requireInstructor();

    const { searchParams } = new URL(request.url);
    const parsed = studentsQuerySchema.safeParse({
      courseId: searchParams.get("courseId") ?? undefined,
      page: searchParams.get("page") ?? undefined,
      pageSize: searchParams.get("pageSize") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      sortBy: searchParams.get("sortBy") ?? undefined,
      sortOrder: searchParams.get("sortOrder") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: parsed.error.errors[0]?.message ?? "Invalid query",
          code: "VALIDATION_ERROR",
        },
        { status: 400 }
      );
    }

    // The schema requires courseId at runtime; this guard also narrows the
    // inferred Zod intersection type before calling typed service functions.
    if (!parsed.data.courseId) {
      return NextResponse.json(
        { success: false, error: "courseId is required", code: "VALIDATION_ERROR" },
        { status: 400 }
      );
    }

    const studentProgressOptions = {
      ...parsed.data,
      courseId: parsed.data.courseId,
    };

    await assertCourseOwnership(studentProgressOptions.courseId, user, {
      allowAdmin: true,
    });

    const { data } = await getStudentProgress(studentProgressOptions);

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    return analyticsAuthErrorResponse(error);
  }
}
